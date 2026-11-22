import { hostname } from "node:os";
import type { GatewayLookup } from "./board-gateway.ts";
import { type LeadSeen, leadSeen } from "./board-lead-seen.ts";
import { type BotLive, LIVE_WORD, type LiveState, type LiveStatus, liveState } from "./board-live.ts";
import type { AgentStatus, SessionRef, SessionRuntime } from "./runtime/types.ts";
import type { Store } from "./store.ts";

/**
 * The lead's seat in the 사무실 tab, read only from what already exists: the lead's pane as roles.json names it now (so
 * a rotation that moves it to another pane is followed), its runtime status word, and the newest thing the lead did on
 * record (leadSeen). The pane's title is not read: it is set once when the session starts. No file or hook of its own;
 * a pane that cannot be read is 상태 모름, never guessed.
 */
export type LeadPane = { readonly status: AgentStatus };
/** Reads the lead's pane: the runtime's probe on the board process, a stub in tests. */
export type LeadProbe = (ref: SessionRef) => Promise<LeadPane>;
/** What the board process reads for the 사무실 tab: this lead's pane, and the other computers' leads' seats. */
export type OfficeReaders = { lead?: LeadProbe; remotes?: () => BotLive[]; gateway?: GatewayLookup };

export const LEAD_NAME = "도리도라";
export const LEAD_ROLE = "조율(lead)";
export const LEAD_UNKNOWN = "상태 모름";
/** A pane read that takes longer than this is 상태 모름: the page never waits on a stuck runtime. */
const PROBE_MS = 2_000;
const PROBE_REUSE_MS = 10_000;

/** The time of day in KST, as the board's header shows it. */
const hhmm = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(11, 16);

const statusOf = (pane: LeadPane | null): LiveStatus =>
  pane?.status === "working" ? "working" : pane?.status === "idle" || pane?.status === "done" ? "idle" : "unknown";

/**
 * A lead as one seat (this board's lead unless `who` says otherwise): its pane's status (null when it could not be
 * read) and its newest record as the line and the time; no record leaves the line empty.
 */
export function leadLive(
  pane: LeadPane | null,
  seen: LeadSeen | null,
  machine: string,
  who = { row: "lead", label: LEAD_NAME, role: LEAD_ROLE },
): BotLive {
  const status = statusOf(pane);
  const base = status === "unknown" ? LEAD_UNKNOWN : LIVE_WORD[status];
  return {
    name: "lead",
    ...who,
    machine,
    task: seen?.what ?? null,
    status,
    word: seen ? `${base} · ${hhmm(seen.at)}` : base,
    at: seen?.at ?? null,
    running: status === "working" ? 1 : 0,
  };
}

async function readPane(ref: SessionRef | undefined, probe: LeadProbe | undefined): Promise<LeadPane | null> {
  if (!ref || !probe) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_MS);
  });
  try {
    const read = Promise.resolve()
      .then(() => probe(ref))
      .catch(() => null);
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The 사무실 tab's state: the lead's seat first, then every bot of agents.json as the 지금 tab reads them, then the other
 * computers' leads.
 */
export async function officeLive(store: Store, now: number, read: OfficeReaders = {}): Promise<LiveState> {
  const ref = store.roles().lead;
  const machine = ref?.machine ?? (hostname().split(".")[0] || "기록 없음");
  const lead = leadLive(await readPane(ref, read.lead), leadSeen(store), machine);
  const live = liveState(store, now, read.gateway);
  return { ...live, bots: [lead, ...live.bots, ...(read.remotes?.() ?? [])] };
}

/**
 * `probe` with its answer reused for `ms` per pane, so the 사무실 tab's reloads (every open page, every 30 s) do not
 * each wait on the runtime. A failed read is reused too: it is 상태 모름 until the window ends.
 */
export function reusedProbe(probe: LeadProbe, now: () => number, ms = PROBE_REUSE_MS): LeadProbe {
  let last: { key: string; at: number; answer: Promise<LeadPane> } | null = null;
  return (ref) => {
    const key = JSON.stringify(ref);
    if (last?.key !== key || now() - last.at >= ms)
      last = { key, at: now(), answer: Promise.resolve().then(() => probe(ref)) };
    return last.answer;
  };
}

/**
 * omo (and Claude Code) print this on the status line just above the input box for the whole of a turn, tool runs
 * included, and never between turns. Only the bottom lines count: the same words higher up are the session's own text.
 */
export const TURN_MARK = "esc to interrupt";
export const TURN_LINES = 8;
const SCREEN_LINES = 30;

/** The screen's last TURN_LINES non-blank lines show a turn in progress. */
export const turnShown = (screen: string): boolean =>
  screen
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-TURN_LINES)
    .some((l) => l.includes(TURN_MARK));

/**
 * The lead's pane through its runtime, as the board process reads it. herdr's status word does not follow an omo
 * session's turns (it says `idle` or `done` mid-turn), so a screen that shows a turn (turnShown) is working whatever
 * herdr says; otherwise herdr's word, after the runtime's own #62 screen check. A read that fails (herdr not on the
 * board's PATH, say) throws, so the seat is 상태 모름, and is one log line each time its reason changes.
 */
export function runtimeLeadProbe(
  runtimeOf: (ref: SessionRef) => SessionRuntime,
  log: (line: string) => void,
): LeadProbe {
  let lastFailure = "";
  return async (ref) => {
    try {
      const rt = runtimeOf(ref);
      const p = await rt.probe(ref);
      const busy = p.status !== "gone" && turnShown(await rt.read(ref, SCREEN_LINES).catch(() => ""));
      lastFailure = "";
      return { status: busy ? "working" : p.status };
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
      if (why !== lastFailure) log(`BOARD_LEAD_PROBE ${ref.id} failed: ${why}`);
      lastFailure = why;
      throw e;
    }
  };
}

/** What the 지금 tab (the bots) and the 사무실 tab (the lead, then the bots) draw; null on every other tab. */
export async function tabLive(tab: string, store: Store, now: number, read?: OfficeReaders): Promise<LiveState | null> {
  if (tab === "live") return liveState(store, now, read?.gateway);
  return tab === "office" ? officeLive(store, now, read) : null;
}
