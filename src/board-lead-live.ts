import { hostname } from "node:os";
import { chatTail } from "./board-chat.ts";
import { type BotLive, LIVE_WORD, type LiveState, type LiveStatus, liveState, taskTitle } from "./board-live.ts";
import type { AgentStatus, SessionRef, SessionRuntime } from "./runtime/types.ts";
import type { Store } from "./store.ts";

/**
 * The lead's seat in the 사무실 tab, read only from what already exists: the lead's pane as roles.json names it now (so
 * a rotation that moves it to another pane is followed), its runtime status word and title, and the newest thing the
 * lead did on record (a lane it started, a `dori reply board`). No file or hook of its own; a pane that cannot be read
 * is 상태 모름, never guessed.
 */
export type LeadPane = { readonly status: AgentStatus; readonly title?: string };
/** Reads the lead's pane: the runtime's probe on the board process, a stub in tests. */
export type LeadProbe = (ref: SessionRef) => Promise<LeadPane>;
/** The newest thing a lead did on record and its time. */
export type LeadSeen = { at: number; what: string };
/** What the board process reads for the 사무실 tab: this lead's pane, and the other computers' leads' seats. */
export type OfficeReaders = { lead?: LeadProbe; remotes?: () => BotLive[] };

export const LEAD_NAME = "도리도라";
export const LEAD_ROLE = "조율(lead)";
export const LEAD_UNKNOWN = "상태 모름";
/** A pane read that takes longer than this is 상태 모름: the page never waits on a stuck runtime. */
const PROBE_MS = 2_000;
const PROBE_REUSE_MS = 10_000;
const CHAT_LINES = 50;

/** The time of day in KST, as the board's header shows it. */
const hhmm = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(11, 16);

/** The newest thing the lead did on record and its time: a lane started or a reply on the board. */
export function leadSeen(store: Store): LeadSeen | null {
  const seen = [
    ...store
      .lanes()
      .flatMap((l) => l.log.filter((e) => e.kind === "start").map((e) => ({ at: e.at, what: `lane ${l.key} 시작` }))),
    ...chatTail(store.root, CHAT_LINES)
      .filter((m) => m.from === "lead")
      .map((m) => ({ at: m.at, what: `답함 · ${taskTitle(m.text)}` })),
  ];
  return seen.reduce<LeadSeen | null>((a, b) => (a && a.at >= b.at ? a : b), null);
}

const statusOf = (pane: LeadPane | null): LiveStatus =>
  pane?.status === "working" ? "working" : pane?.status === "idle" || pane?.status === "done" ? "idle" : "unknown";

/**
 * A lead as one seat (this board's lead unless `who` says otherwise): its pane's status (null when it could not be
 * read), the pane title or else the newest record.
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
    task: (pane?.title && taskTitle(pane.title)) || seen?.what || null,
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
  const live = liveState(store, now);
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

/** omo prints this on its status line for the whole of a turn, tool runs included. */
export const TURN_MARK = "esc to interrupt";
const SCREEN_LINES = 30;

/**
 * The lead's pane through its runtime, as the board process reads it. herdr can report an omo at work as `idle` (it
 * does not follow omo's turns), so an idle pane whose screen shows a turn (TURN_MARK) is working. A read that fails
 * (herdr not on the board's PATH, say) throws, so the seat is 상태 모름, and is one log line each time its reason changes.
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
      const busy = p.status === "idle" && (await rt.read(ref, SCREEN_LINES).catch(() => "")).includes(TURN_MARK);
      lastFailure = "";
      return { status: busy ? "working" : p.status, ...(p.title ? { title: p.title } : {}) };
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
  if (tab === "live") return liveState(store, now);
  return tab === "office" ? officeLive(store, now, read) : null;
}
