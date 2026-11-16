// Start the next backlog item as soon as a slot is free, instead of waiting for the hourly loop: right after
// `dori backlog add`, right after `dori done`, and on every duty pass. Same limits and lock as the hourly loop.
import type { Deps } from "./harness.ts";
import { done } from "./lanes.ts";
import { acquire, release } from "./loop-lock.ts";
import { type PullLimits, pull, pullCandidates } from "./loop-pull.ts";
import type { LoopRun } from "./store-types.ts";

/** A start that failed is tried again by autostart after this long; the hourly loop still counts its own tries. */
export const RETRY_AFTER_MS = 60 * 60_000;

const envNumber = (name: string, fallback: number | undefined): number | undefined => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** The hourly loop's limits as `dori loop` reads them: DORI_MAX_LANES (3), DORI_MAX_STARTS (2), DORI_MAX_LOAD (cores). */
const envLimits = (): PullLimits => ({
  maxLanes: envNumber("DORI_MAX_LANES", 3)!,
  maxStarts: envNumber("DORI_MAX_STARTS", 2)!,
  maxLoad: envNumber("DORI_MAX_LOAD", undefined),
});

/**
 * Starts what the free slots allow and returns one line per start or failure. Does nothing when DORI_AUTOSTART=off,
 * when the hourly loop is stopped, when another loop holds the lock (it is pulling already), or when no item is
 * waiting. The lanes it opens tell the lead [START] themselves.
 */
export async function startNow(d: Deps, by: string, limits: PullLimits = envLimits()): Promise<string[]> {
  if (process.env["DORI_AUTOSTART"] === "off" || d.store.stop() || pullCandidates(d).length === 0) return [];
  const lock = acquire(d);
  if ("holder" in lock) return [];
  try {
    const run: LoopRun = { at: d.now(), synced: [], findings: [], started: [], held: [], asked: [] };
    await pull(d, run, limits, lock.nonce, { by, retryAfterMs: RETRY_AFTER_MS });
    return [...run.started.map((s) => `started ${s}`), ...run.findings];
  } finally {
    release(d, lock.nonce);
  }
}

/** `dori done`, then the freed slot goes to the next waiting item at once. */
export async function doneThenStart(d: Deps, key: string, limits: PullLimits = envLimits()): Promise<string[]> {
  await done(d, key);
  return startNow(d, `autostart after ${key} was done`, limits);
}
