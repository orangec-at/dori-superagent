import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Agent } from "./agents.ts";
import { readAssignments } from "./autopilot-store.ts";
import { tailJson } from "./board-agents.ts";
import { agentsOrNone } from "./board-avatars.ts";
import { botLabel, DELEGATION_TAIL_BYTES, decodeEscapes } from "./board-bots.ts";
import type { Store } from "./store.ts";

/**
 * The 지금 tab and GET /api/live: each bot of agents.json, the work it was last given and how that stands now. Read only
 * from what `dori delegate` writes (delegate-runs.jsonl when the bot's process starts, delegations.jsonl when it ends;
 * the lead's own delegations included) and the autopilot's hand-outs (autopilot/assignments.jsonl). What no record
 * shows is `unknown` with the time of the last record, never guessed. It carries a one-line title of the work, never
 * the instruction, the bot's output or a host address: the pixel office reads this same data.
 */
export type LiveStatus = "working" | "done" | "failed" | "idle" | "unknown";
export const LIVE_WORD: Record<LiveStatus, string> = {
  working: "일하는 중",
  done: "방금 끝남",
  failed: "실패",
  idle: "대기",
  unknown: "상태 확인 안 됨",
};
/**
 * `task`: the title of the work (null when there is none: idle, or no record); `at`: when the run started (working),
 * ended (done, failed, idle) or the last record about it was written (unknown; null when there is none); `running`: how
 * many runs are at work at once. `row`: the board row id when it is not `bot:<name>` (the lead's seat is `lead`); `role`:
 * a role shown beside the name.
 */
export type BotLive = {
  name: string;
  row?: string;
  role?: string;
  label: string;
  machine: string;
  task: string | null;
  status: LiveStatus;
  word: string;
  at: number | null;
  running: number;
};
export type LiveState = { generatedAt: number; bots: BotLive[] };

/** One delegation: its start, its timeout and its end when one is written. */
export type LiveRun = { at: number; until: number; text: string; end?: { at: number; outcome: string } };
/** What the records say about one bot: its runs oldest first and the newest roadmap task the autopilot handed it. */
export type BotRecords = { runs: LiveRun[]; handed: { at: number; text: string } | null };

/** A run that ended ok this recently is 방금 끝남, then 대기. */
export const JUST_DONE_MS = 15 * 60_000;
/** A run this far past its timeout without an end: its process died or its end was lost. */
const RUN_GRACE_MS = 60_000;
/** The autopilot writes its hand-out right after the run starts: one this much newer than the newest start never ran. */
const START_SLACK_MS = 60_000;
const TITLE_MAX = 80;

/**
 * The work in one line of at most 80 characters: the first sentence of the instruction's first line, without the leading @bot, links, email
 * addresses, IP addresses or long tokens; a file path is cut to its file name.
 */
export function taskTitle(text: string): string {
  const line =
    decodeEscapes(text)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const t = line
    .replace(/^@\S+\s*/, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "")
    .replace(/(?:~|\/[\w.-]+)(?:\/[\w.@-]+)+\/?/g, (p) => p.split("/").filter(Boolean).at(-1) ?? "")
    .replace(/\b[\w-]{32,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(.{8,}?[.!?])\s.*$/, "$1");
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

type Live = Pick<BotLive, "task" | "status" | "at" | "running">;

/**
 * A bot's state at `now`. 일하는 중 only while a started run has no end and is within its timeout; a hand-out with no
 * run started after it, or a run past its timeout without an end, is 상태 확인 안 됨.
 */
export function botLive(r: BotRecords, now: number): Live {
  const open = r.runs.filter((x) => x.end === undefined && now <= x.until + RUN_GRACE_MS);
  const at = open.at(-1);
  if (at) return { status: "working", task: taskTitle(at.text), at: at.at, running: open.length };
  const last = r.runs.at(-1);
  const one = (status: LiveStatus, task: string | null, when: number | null): Live => ({
    status,
    task,
    at: when,
    running: 0,
  });
  if (r.handed && r.handed.at > (last?.at ?? Number.NEGATIVE_INFINITY) + START_SLACK_MS)
    return one("unknown", taskTitle(r.handed.text), r.handed.at);
  if (!last) return one("unknown", null, null);
  if (!last.end) return one("unknown", taskTitle(last.text), last.at);
  if (last.end.outcome !== "ok") return one("failed", taskTitle(last.text), last.end.at);
  return now - last.end.at < JUST_DONE_MS
    ? one("done", taskTitle(last.text), last.end.at)
    : one("idle", null, last.end.at);
}

const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);

/**
 * Every bot's records from the tails of the two delegation logs and the autopilot's hand-outs. An end without a start
 * (written before delegate-runs.jsonl existed) is a run of its own. Once delegations.jsonl is longer than its tail, a
 * start older than the oldest end read is dropped: its end may simply be out of reach.
 */
export function liveRecords(home: string): Map<string, BotRecords> {
  const out = new Map<string, BotRecords>();
  const of = (bot: string): BotRecords => {
    const r = out.get(bot) ?? { runs: [], handed: null };
    out.set(bot, r);
    return r;
  };
  const ends = new Map<string, { agent: string; start: number; text: string; end: NonNullable<LiveRun["end"]> }>();
  for (const e of tailJson(join(home, "delegations.jsonl"))) {
    const at = ms(e["at"]);
    if (typeof e["agent"] !== "string" || Number.isNaN(at)) continue;
    const end = ms(e["endedAt"]);
    const done = { at: Number.isNaN(end) ? at : end, outcome: String(e["outcome"]) };
    ends.set(`${e["agent"]}|${at}`, { agent: e["agent"], start: at, text: String(e["text"] ?? ""), end: done });
  }
  const path = join(home, "delegations.jsonl");
  const cut = existsSync(path) && statSync(path).size > DELEGATION_TAIL_BYTES && ends.size > 0;
  const oldest = cut ? Math.min(...[...ends.values()].map((e) => e.start)) : Number.NEGATIVE_INFINITY;
  for (const v of tailJson(join(home, "delegate-runs.jsonl"))) {
    const at = ms(v["at"]);
    if (typeof v["agent"] !== "string" || Number.isNaN(at)) continue;
    const key = `${v["agent"]}|${at}`;
    const ended = ends.get(key);
    ends.delete(key);
    if (!ended && at < oldest) continue;
    const until = ms(v["until"]);
    const run: LiveRun = { at, until: Number.isNaN(until) ? at : until, text: String(v["text"] ?? "") };
    of(v["agent"]).runs.push(ended ? { ...run, end: ended.end } : run);
  }
  for (const e of ends.values()) of(e.agent).runs.push({ at: e.start, until: e.start, text: e.text, end: e.end });
  for (const r of out.values()) r.runs.sort((a, b) => a.at - b.at);
  for (const a of readAssignments(home))
    if (a.kind === "delegate" && a.bot && a.at >= (of(a.bot).handed?.at ?? 0))
      of(a.bot).handed = { at: a.at, text: a.text };
  return out;
}

/** The machine a bot runs on: the name in its description ("연도(fedora): ..."), else its ssh host's name, else this one. */
const machineOf = (a: Agent): string =>
  /\(([^)]+)\)/.exec(a.description)?.[1]?.trim() ||
  (a.host ? (a.host.split("@").at(-1) ?? a.host) : hostname()).split(".")[0] ||
  "기록 없음";

/** Every bot of agents.json in its order, as the 지금 tab and GET /api/live show it. */
export function liveState(store: Store, now: number): LiveState {
  const records = liveRecords(store.root);
  const bots = agentsOrNone(store.root).map((a) => {
    const s = botLive(records.get(a.name) ?? { runs: [], handed: null }, now);
    return { name: a.name, label: botLabel(a), machine: machineOf(a), ...s, word: LIVE_WORD[s.status] };
  });
  return { generatedAt: now, bots };
}
