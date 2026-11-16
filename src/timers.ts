import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { takeInboxLock } from "./inbox-lock.ts";
import { Refusal } from "./refusal.ts";
import { KEY_RE } from "./store-types.ts";

/**
 * A follow-up the lead or a lane set for itself instead of remembering it: at `at` the duty loop types
 * `[TIMER <id>] <text>` into the lead's pane once. A repeating timer (`every`) then moves to its next time; a one-off is done.
 */
export type Timer = {
  id: string;
  at: number;
  text: string;
  every?: number;
  status: "pending" | "done" | "cancelled";
  createdAt: number;
  firedAt?: number;
};

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_EVERY_MS = 60_000;

const span = (spec: string): number | undefined => {
  const m = /^(\d+)([smhd])$/.exec(spec);
  return m ? Number(m[1]) * UNIT_MS[m[2]!]! : undefined;
};

/** `--at`: an ISO time with a date (2026-11-17T09:00+09:00) or a delay from now (+30m, +2h, +1d, +90s). */
export function parseAt(spec: string, now: number): number {
  const delay = spec.startsWith("+") ? span(spec.slice(1)) : undefined;
  if (delay !== undefined) return now + delay;
  const at = /^\d{4}-\d{2}-\d{2}/.test(spec) ? Date.parse(spec) : Number.NaN;
  if (Number.isNaN(at)) throw new Refusal(`--at must be an ISO time (2026-11-17T09:00+09:00) or +N[smhd], not ${spec}`);
  return at;
}

/** `--every`: an interval of at least one minute (30m, 2h, 1d); cron expressions are not supported. */
export function parseEvery(spec: string): number {
  const ms = span(spec);
  if (ms === undefined || ms < MIN_EVERY_MS)
    throw new Refusal(`--every must be an interval of 1m or more (30m, 2h, 1d), not ${spec}`);
  return ms;
}

export const timersPath = (home: string): string => join(home, "timers.json");

export function loadTimers(home: string): Timer[] {
  const path = timersPath(home);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Timer[]) : [];
}

/** Written to a temp file and renamed over timers.json, so a crash leaves the old list or the new one, never half. */
function saveTimers(home: string, timers: readonly Timer[]): void {
  const path = timersPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(timers, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Runs `change` on the list under timers.json.lock, so `dori timer add` and a duty pass never drop each other's write. */
function withTimers<T>(d: Deps, change: (timers: Timer[]) => T): T | undefined {
  const release = takeInboxLock(`${timersPath(d.store.root)}.lock`, d.now());
  if (!release) return undefined;
  try {
    const timers = loadTimers(d.store.root);
    const out = change(timers);
    saveTimers(d.store.root, timers);
    return out;
  } finally {
    release();
  }
}

const locked = <T>(d: Deps, change: (timers: Timer[]) => T): T => {
  for (let tries = 0; tries < 20; tries++) {
    const out = withTimers(d, (t) => ({ v: change(t) }));
    if (out) return out.v;
    Bun.sleepSync(50);
  }
  throw new Refusal("timers.json is locked by another dori process; try again");
};

export function addTimer(d: Deps, id: string, at: number, text: string, every?: number): Timer {
  if (!KEY_RE.test(id)) throw new Refusal(`timer id must match ${KEY_RE}`);
  if (!text.trim()) throw new Refusal("--text must say what to check");
  return locked(d, (timers) => {
    if (timers.some((t) => t.id === id && t.status === "pending"))
      throw new Refusal(`timer ${id} is already pending; cancel it first`);
    const timer: Timer = {
      id,
      at,
      text,
      status: "pending",
      createdAt: d.now(),
      ...(every !== undefined ? { every } : {}),
    };
    timers.splice(0, timers.length, ...timers.filter((t) => t.id !== id), timer);
    return timer;
  });
}

export function cancelTimer(d: Deps, id: string): void {
  locked(d, (timers) => {
    const t = timers.find((x) => x.id === id && x.status === "pending");
    if (!t) throw new Refusal(`no pending timer ${id}`);
    t.status = "cancelled";
  });
}

/** The first `every` step after `now`: missed repeats while dori was down are skipped, not delivered one by one. */
const nextAt = (t: Timer, now: number): number => t.at + (Math.floor((now - t.at) / t.every!) + 1) * t.every!;

export type TimerEvent = { action: "timer-fired" | "timer-failed" | "timers-locked"; detail?: string };

/**
 * One duty pass: every pending timer at or past its time is claimed (done, or moved to its next time) and saved before
 * `[TIMER <id>]` goes to the lead, so a crash or a second pass can never deliver it twice. A timer is due again after a
 * restart because only the claim, written to disk, retires it. With no lead registered nothing is claimed.
 */
export async function fireTimers(d: Deps): Promise<TimerEvent[]> {
  if (!d.store.roles().lead) return [];
  const now = d.now();
  const isDue = (t: Timer): boolean => t.status === "pending" && t.at <= now;
  if (!loadTimers(d.store.root).some(isDue)) return [];
  const due = withTimers(d, (timers) =>
    timers.filter(isDue).map((t) => {
      const fired = { ...t };
      t.firedAt = now;
      if (t.every !== undefined) t.at = nextAt(t, now);
      else t.status = "done";
      return fired;
    }),
  );
  if (due === undefined) return [{ action: "timers-locked" }];
  const events: TimerEvent[] = [];
  for (const t of due) {
    try {
      await tellLead(d, `[TIMER ${t.id}] ${t.text}`, "timer");
      events.push({ action: "timer-fired", detail: t.id });
    } catch (e) {
      // Claimed already: a delivery that may have landed is not retried, the duty log shows it instead.
      events.push({ action: "timer-failed", detail: `${t.id}: ${failureDetail(e)}` });
    }
  }
  return events;
}

export const timerLine = (t: Timer): string =>
  `${t.id.padEnd(24)} ${t.status.padEnd(9)} ${new Date(t.at).toISOString()}${
    t.every !== undefined ? ` every ${t.every / 60_000}m` : ""
  }  ${t.text}`;
