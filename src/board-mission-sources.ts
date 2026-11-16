import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./agents.ts";
import { botLabel } from "./board-bots.ts";
import type { Actor, Routine } from "./board-mission-types.ts";

/**
 * Small readers for the records a mission is built from: the bracket tag a delegate instruction starts with, links in
 * a bot's answer, a lane brief's title and the Muse inbox. Nothing here calls a model or the network.
 */

const TAG_RE = /^\s*\[([^\]\n]{1,60})\]/;
const URL_RE = /https?:\/\/[^\s)<>\]"'`|]+/;
const ISSUE_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(#issuecomment-\d+)?/g;
const PR_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const TITLE_MAX = 90;

const machineOf = (host: string): string => (host === "" ? "fedora" : (host.split("@").pop() ?? host));

/** The name and machine (or kind) shown for a participant id. */
export const actorOf =
  (agents: Agent[]) =>
  (id: string): Actor => {
    const [kind, name = ""] = id.split(/:(.*)/s);
    const agent = agents.find((a) => a.name === name);
    if (id === "lead") return { id, label: "도리도라", sub: "lead" };
    if (kind === "bot") return { id, label: agent ? botLabel(agent) : name, sub: agent ? machineOf(agent.host) : "봇" };
    if (kind === "standing") return { id, label: `${name} 리드`, sub: "상시 리드" };
    if (kind === "lane") return { id, label: name, sub: "lane" };
    if (kind === "gh") return { id, label: name.split("/")[1] ?? name, sub: "GitHub" };
    return { id, label: "Muse", sub: "게시" };
  };

/** `[아침 배정 2026-11-16] ...` -> `아침 배정 2026-11-16`: the tag the lead puts in front of a delegate instruction. */
export const tagOf = (text: string): string | null => TAG_RE.exec(text)?.[1]?.trim() || null;
export const withoutTag = (text: string): string => text.replace(TAG_RE, "").trim();

export const firstUrl = (text: string): string | null => URL_RE.exec(text)?.[0] ?? null;

/** Every GitHub issue (or issue comment) link in the text, once each. */
export function issueLinks(text: string): { repo: string; num: number; comment: boolean; url: string }[] {
  const seen = new Set<string>();
  return [...text.matchAll(ISSUE_RE)].flatMap((m) => {
    if (seen.has(m[0])) return [];
    seen.add(m[0]);
    return [{ repo: m[1]!, num: Number(m[2]), comment: m[3] !== undefined, url: m[0] }];
  });
}

/** `owner/repo#N` for every pull request link in the text. */
export const prKeys = (text: string): string[] => [...text.matchAll(PR_RE)].map((m) => `${m[1]}#${m[2]}`);

/** A lane brief's first `# ` heading without the `key:` it usually starts with; the key when there is none. */
export function briefTitle(path: string, key: string): string {
  let heading: string | undefined;
  try {
    heading = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith("# "));
  } catch {
    return key;
  }
  if (!heading) return key;
  let t = heading.slice(2).trim();
  if (t.startsWith(key)) t = t.slice(key.length).replace(/^\s*[:：-]\s*/, "");
  t ||= key;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** `2026-11-11 14:50` (written in KST), an ISO string or epoch ms; null for anything else. */
export function timeOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}:00+09:00` : v);
  return Number.isNaN(at) ? null : at;
}

const newest = (dir: string, re: RegExp): RegExpExecArray | null => {
  try {
    return (
      readdirSync(dir)
        .filter((f) => re.test(f))
        .sort()
        .map((f) => re.exec(f))
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
};

/** The morning assignment (its newest out/daily-assign file), the hourly loop (its newest loop/runs stamp) and duty. */
export function routines(home: string): Routine[] {
  const assign = newest(join(home, "out"), /^daily-assign-(\d{4}-\d{2}-\d{2})\.md$/);
  const run = newest(join(home, "loop", "runs"), /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z\.json$/);
  return [
    {
      name: "아침 배정",
      when: "매일 09:00 KST · 봇마다 결과물 1개",
      last: assign ? Date.parse(`${assign[1]}T09:00:00+09:00`) : null,
      for: ["bot", "lead"],
    },
    {
      name: "정시 루프",
      when: "매시간 · 백로그 다음 일 시작, 결정 묻기",
      last: run ? Date.parse(`${run[1]}T${run[2]}:${run[3]}:${run[4]}Z`) : null,
      for: ["lead", "standing"],
    },
    { name: "duty 점검", when: "1분마다 · 조용한 lane 재촉, 끊김 확인", last: null, for: ["lane", "lead"] },
  ];
}

/** What the lead put in the Muse inbox (DORI_HOME/muse/inbox.jsonl); a line that is not a message is skipped. */
export function museInbox(home: string): { at: number; text: string }[] {
  const path = join(home, "muse", "inbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const v = JSON.parse(line) as Record<string, unknown>;
        const at = timeOf(v["at"]);
        return at !== null && typeof v["text"] === "string" ? [{ at, text: v["text"] }] : [];
      } catch {
        return [];
      }
    });
}
