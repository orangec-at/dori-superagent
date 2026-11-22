import { hostname } from "node:os";
import { chatTail } from "./board-chat.ts";
import { type BotLive, LIVE_WORD, type LiveState, type LiveStatus, liveState, taskTitle } from "./board-live.ts";
import type { AgentStatus, SessionRef } from "./runtime/types.ts";
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

export const LEAD_NAME = "도리도라";
export const LEAD_ROLE = "조율(lead)";
export const LEAD_UNKNOWN = "상태 모름";
/** A pane read that takes longer than this is 상태 모름: the page never waits on a stuck runtime. */
const PROBE_MS = 2_000;
const CHAT_LINES = 50;

/** The time of day in KST, as the board's header shows it. */
const hhmm = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(11, 16);

/** The newest thing the lead did on record and its time: a lane started or a reply on the board. */
export function leadSeen(store: Store): { at: number; what: string } | null {
  const seen = [
    ...store
      .lanes()
      .flatMap((l) => l.log.filter((e) => e.kind === "start").map((e) => ({ at: e.at, what: `lane ${l.key} 시작` }))),
    ...chatTail(store.root, CHAT_LINES)
      .filter((m) => m.from === "lead")
      .map((m) => ({ at: m.at, what: `답함 · ${taskTitle(m.text)}` })),
  ];
  return seen.reduce<{ at: number; what: string } | null>((a, b) => (a && a.at >= b.at ? a : b), null);
}

const statusOf = (pane: LeadPane | null): LiveStatus =>
  pane?.status === "working" ? "working" : pane?.status === "idle" || pane?.status === "done" ? "idle" : "unknown";

/** The lead as one seat: its pane's status (null when it could not be read), the pane title or else the newest record. */
export function leadLive(pane: LeadPane | null, seen: { at: number; what: string } | null, machine: string): BotLive {
  const status = statusOf(pane);
  const base = status === "unknown" ? LEAD_UNKNOWN : LIVE_WORD[status];
  return {
    name: "lead",
    row: "lead",
    label: LEAD_NAME,
    role: LEAD_ROLE,
    machine,
    task: pane?.title?.trim() || seen?.what || null,
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
    return await Promise.race([probe(ref).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The 사무실 tab's state: the lead's seat first, then every bot of agents.json as the 지금 tab reads them. */
export async function officeLive(store: Store, now: number, probe?: LeadProbe): Promise<LiveState> {
  const ref = store.roles().lead;
  const machine = ref?.machine ?? (hostname().split(".")[0] || "기록 없음");
  const lead = leadLive(await readPane(ref, probe), leadSeen(store), machine);
  const live = liveState(store, now);
  return { ...live, bots: [lead, ...live.bots] };
}

/** What the 지금 tab (the bots) and the 사무실 tab (the lead, then the bots) draw; null on every other tab. */
export async function tabLive(tab: string, store: Store, now: number, probe?: LeadProbe): Promise<LiveState | null> {
  if (tab === "live") return liveState(store, now);
  return tab === "office" ? officeLive(store, now, probe) : null;
}
