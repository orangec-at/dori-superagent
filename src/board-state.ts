import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ask, asks } from "./asks.ts";
import { type BotCard, botCards, firstLine } from "./board-bots.ts";
import { type ChatMessage, chatTail } from "./board-chat.ts";
import { lanePrs, type Pr } from "./board-prs.ts";
import { type StandingCard, standingCards } from "./board-status.ts";
import { NUDGE_MINUTES } from "./duty.ts";
import type { Store } from "./store.ts";
import type { ItemStatus, LaneStatus } from "./store-types.ts";

/** `prs`: the pull requests the lane names; `escalated`: duty used every nudge on it and told the lead (ESCALATE). */
export type ProjectLane = {
  key: string;
  status: LaneStatus;
  at: number;
  first: string;
  full: string;
  prs: Pr[];
  escalated: boolean;
  /** A done backlog item listed with the day's finished lanes, not a lane. */
  item?: true;
};
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
  standing: StandingCard[];
  /** Why leads.json could not be read. */
  standingError: string | null;
  /** The newest messages between the operator and the lead, oldest first. */
  chat: ChatMessage[];
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
const CHAT_SHOWN = 60;

/** The project a lane or item belongs to: the first project with a word in its text, else 기타. */
export function projectOf(projects: Record<string, string[]>, ...texts: string[]): string {
  const hay = texts.join(" ").toLowerCase();
  return Object.entries(projects).find(([, words]) => words.some((w) => hay.includes(w.toLowerCase())))?.[0] ?? OTHER;
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
    const entry = l.log.at(-1);
    const latest = entry?.kind === "start" || entry?.kind === "adopt" ? "시작함" : entry?.text;
    const last = l.status === "ready" || l.status === "done" ? (l.final?.text ?? latest) : latest;
    const pl: ProjectLane = {
      key: l.key,
      status: l.status,
      at: l.lastActivityAt,
      first: firstLine(last ?? ""),
      full: last ?? "",
      prs: lanePrs(l),
      escalated: l.status === "working" && l.nudges >= NUDGE_MINUTES.length,
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
      const title = firstLine(i.title);
      g.done.push({
        key: i.id,
        status: "done",
        at: i.updatedAt,
        first: title,
        full: i.title,
        prs: [],
        escalated: false,
        item: true,
      });
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
  const standing = standingCards(store, now);
  return {
    generatedAt: now,
    standing: standing.cards,
    standingError: standing.error,
    chat: chatTail(store.root, CHAT_SHOWN),
    asks: asks(store.root).filter((a) => a.status === "open"),
    attention: attention.sort((a, b) => b.at - a.at),
    bots: botCards(store.root, now),
    projects: sorted,
  };
}
