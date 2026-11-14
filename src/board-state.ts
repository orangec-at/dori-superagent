import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Agent, loadAgents } from "./agents.ts";
import { type Ask, asks } from "./asks.ts";
import type { Store } from "./store.ts";
import type { ItemStatus, LaneStatus } from "./store-types.ts";

/** One bot from agents.json with what the day's assignment file and the delegation log say about it. */
export type BotCard = {
  name: string;
  label: string;
  role: string;
  today: string | null;
  result: string | null;
  lastDelegate: { at: string; outcome: string; summary: string } | null;
};

export type ProjectLane = { key: string; status: LaneStatus; at: number; first: string; full: string };
export type ProjectGroup = {
  name: string;
  lanes: ProjectLane[];
  backlog: { id: string; title: string; priority: number; status: ItemStatus; decision: string | null }[];
  done: ProjectLane[];
};

export type BoardState = {
  generatedAt: number;
  asks: Ask[];
  /** Lanes the operator should look at: ready (a PR to check), waiting, lost. */
  attention: ProjectLane[];
  bots: BotCard[];
  projects: ProjectGroup[];
};

/** Default project names and the words that put a lane's key, cwd or a backlog item's id/title/cwd into them. */
export const DEFAULT_PROJECTS: Record<string, string[]> = {
  vibeguard: ["vibeguard", "vg-", "fmv"],
  coupas: ["coupas"],
  yogaday: ["yogaday", "yd-"],
  drawhatha: ["drawhatha", "dh-"],
  corpus: ["corpus"],
  dori: ["dori", "phone-board"],
};
const OTHER = "기타";
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const DELEGATION_TAIL_BYTES = 256 * 1024;
const CUT = 160;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n = CUT): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The first non-empty line of a lane report, without the box-drawing a hermes answer is framed in. */
export const firstLine = (text: string): string =>
  clip(
    text
      .split("\n")
      .map((l) => oneLine(l.replace(/[│┃╭╮╰╯─━┌┐└┘|]/g, " ")))
      .find((l) => l !== "") ?? "",
  );

/** The project a lane or item belongs to: the first project with a word in its text, else 기타. */
export function projectOf(projects: Record<string, string[]>, ...texts: string[]): string {
  const hay = texts.join(" ").toLowerCase();
  return Object.entries(projects).find(([, words]) => words.some((w) => hay.includes(w.toLowerCase())))?.[0] ?? OTHER;
}

/** The bot's Korean name: the description up to its first "(" ("엔도(fedora): ..." -> 엔도), else its name. */
export const botLabel = (a: Agent): string => /^([^(:]+)\(/.exec(a.description)?.[1]?.trim() || a.name;

/** The KST date (YYYY-MM-DD) the daily-assign file of `now` is named after. */
export const kstDate = (now: number): string => new Date(now + KST_MS).toISOString().slice(0, 10);

/**
 * The bot's row of the assignment table (`| 판붕이 | 결과물 | 근거 |`, a cell may name several bots joined by ·) and
 * its last line in the results list (`- 판붕이 ✅ ...`). null for what the file does not say.
 */
export function assignmentOf(md: string, label: string): { today: string | null; result: string | null } {
  const lines = md.split("\n");
  const row = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .find((cells) => (cells[1] ?? "").split(/[·,/]/).some((n) => n.trim() === label));
  const results = lines.filter((l) => l.startsWith(`- ${label} `) || l.startsWith(`- ${label}\t`));
  const today = row?.[2] ? clip(oneLine(row[2])) : null;
  return { today, result: results.length ? clip(oneLine(results.at(-1)!.slice(2 + label.length))) : null };
}

/** A delegate answer in one line: its last line outside the hermes tool trace (lines framed with │), else the trace's first. */
export function delegateSummary(output: string): string {
  const answer = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^[│┃╭╰]/.test(l));
  return answer.length ? clip(oneLine(answer.at(-1)!)) : firstLine(output);
}

/** The last lines of delegations.jsonl; a line cut by the tail or not JSON is skipped. */
function delegations(home: string): { at: string; agent: string; outcome: string; output: string }[] {
  const path = join(home, "delegations.jsonl");
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const len = Math.min(size, DELEGATION_TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf
    .toString("utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as Record<string, unknown>;
        return typeof v["agent"] === "string" && typeof v["at"] === "string"
          ? [{ at: v["at"], agent: v["agent"], outcome: String(v["outcome"] ?? ""), output: String(v["output"] ?? "") }]
          : [];
      } catch {
        return [];
      }
    });
}

function botCards(home: string, now: number): BotCard[] {
  let agents: Agent[];
  try {
    agents = loadAgents(home);
  } catch {
    return [];
  }
  const assignFile = join(home, "out", `daily-assign-${kstDate(now)}.md`);
  const md = existsSync(assignFile) ? readFileSync(assignFile, "utf8") : "";
  const log = delegations(home);
  return agents.map((a) => {
    const label = botLabel(a);
    const last = log.filter((l) => l.agent === a.name).at(-1);
    return {
      name: a.name,
      label,
      role: a.role,
      ...assignmentOf(md, label),
      lastDelegate: last ? { at: last.at, outcome: last.outcome, summary: delegateSummary(last.output) } : null,
    };
  });
}

/** board.json `projects` when it is an object of word lists; anything else (or an unreadable file) is the default. */
function projectsOf(home: string): Record<string, string[]> {
  const path = join(home, "board.json");
  try {
    const p = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["projects"]
      : undefined;
    const entries = p && typeof p === "object" && !Array.isArray(p) ? Object.entries(p) : [];
    const valid = entries.filter(
      (e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((w) => typeof w === "string" && w !== ""),
    );
    return valid.length > 0 ? Object.fromEntries(valid) : DEFAULT_PROJECTS;
  } catch {
    return DEFAULT_PROJECTS;
  }
}

export function boardState(store: Store, now: number): BoardState {
  const projects = projectsOf(store.root);
  const groups = new Map<string, ProjectGroup>();
  const group = (name: string): ProjectGroup => {
    const found = groups.get(name);
    if (found) return found;
    const g: ProjectGroup = { name, lanes: [], backlog: [], done: [] };
    groups.set(name, g);
    return g;
  };
  const attention: ProjectLane[] = [];
  for (const l of store.lanes()) {
    const last =
      l.status === "ready" || l.status === "done" ? (l.final?.text ?? l.log.at(-1)?.text) : l.log.at(-1)?.text;
    const pl: ProjectLane = {
      key: l.key,
      status: l.status,
      at: l.lastActivityAt,
      first: firstLine(last ?? ""),
      full: last ?? "",
    };
    if (l.status === "done") {
      if (now - l.lastActivityAt < DAY_MS) group(projectOf(projects, l.key, l.cwd)).done.push(pl);
      continue;
    }
    group(projectOf(projects, l.key, l.cwd)).lanes.push(pl);
    if (l.status !== "working") attention.push(pl);
  }
  for (const i of store.items()) {
    if (i.status === "dropped" || (i.status === "done" && now - i.updatedAt >= DAY_MS)) continue;
    const g = group(projectOf(projects, i.id, i.title, i.cwd));
    if (i.status === "done") {
      g.done.push({ key: i.id, status: "done", at: i.updatedAt, first: firstLine(i.title), full: i.title });
      continue;
    }
    g.backlog.push({ id: i.id, title: i.title, priority: i.priority, status: i.status, decision: i.decision ?? null });
  }
  const order = [...Object.keys(projects), OTHER];
  const sorted = [...groups.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  for (const g of sorted) {
    g.lanes.sort((a, b) => b.at - a.at);
    g.done.sort((a, b) => b.at - a.at);
    g.backlog.sort((a, b) => a.priority - b.priority);
  }
  return {
    generatedAt: now,
    asks: asks(store.root).filter((a) => a.status === "open"),
    attention: attention.sort((a, b) => b.at - a.at),
    bots: botCards(store.root, now),
    projects: sorted,
  };
}
