// Start the next backlog item as soon as a slot is free, instead of waiting for the hourly loop: right after
// `dori backlog add`, right after `dori done`, and on every duty pass. Same limits and lock as the hourly loop.
import type { Deps } from "./harness.ts";
import { done } from "./lanes.ts";
import { acquire, release } from "./loop-lock.ts";
import { isOpenLane, loopLimits, type PullLimits, pull, pullCandidates, settleEnded } from "./loop-pull.ts";
import type { LoopRun } from "./store-types.ts";

/** A start that failed is tried again by autostart after this long; the hourly loop still counts its own tries. */
export const RETRY_AFTER_MS = 60 * 60_000;

const envNumber = (name: string, fallback: number | undefined): number | undefined => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback;
};

/**
 * The hourly loop's limits: what the running `dori loop` recorded (its --max-* flags win there), else what it would
 * read from DORI_MAX_LANES (3), DORI_MAX_STARTS (2) and DORI_MAX_LOAD (cores).
 */
const loopOrEnv = (d: Deps): PullLimits => loopLimits(d) ?? envLimits();

const envLimits = (): PullLimits => ({
  maxLanes: envNumber("DORI_MAX_LANES", 3)!,
  maxStarts: envNumber("DORI_MAX_STARTS", 2)!,
  maxLoad: envNumber("DORI_MAX_LOAD", undefined),
});

/**
 * Running items whose lane is done or lost leave running at once (`settleEnded`), not at the next hourly pass, so the
 * backlog never shows a closed lane's item as running. Skipped while the hourly loop is stopped or holds the lock.
 */
function settleNow(d: Deps): string[] {
  const ended = () =>
    d.store.items().filter((i) => i.status === "running" && !isOpenLane(d.store.lane(i.id)?.status ?? "done"));
  if (d.store.stop() || ended().length === 0) return [];
  const lock = acquire(d);
  if ("holder" in lock) return [];
  try {
    return ended().flatMap((i) => {
      const line = settleEnded(d, i);
      return line ? [`synced ${line}`] : [];
    });
  } finally {
    release(d, lock.nonce);
  }
}

/**
 * Settles ended lanes' items, then starts what the free slots allow and returns one line per change, start or failure.
 * Starts nothing when DORI_AUTOSTART=off, when the hourly loop is stopped, when another loop holds the lock (it is
 * pulling already), or when no item is waiting. The lanes it opens tell the lead [START] themselves.
 */
export async function startNow(d: Deps, by: string, limits?: PullLimits): Promise<string[]> {
  const settled = settleNow(d);
  if (process.env["DORI_AUTOSTART"] === "off" || d.store.stop() || pullCandidates(d).length === 0) return settled;
  const lock = acquire(d);
  if ("holder" in lock) return [];
  try {
    const run: LoopRun = { at: d.now(), synced: [], findings: [], started: [], held: [], asked: [] };
    await pull(d, run, limits ?? loopOrEnv(d), lock.nonce, { by, retryAfterMs: RETRY_AFTER_MS });
    return [...settled, ...run.started.map((s) => `started ${s}`), ...run.findings];
  } finally {
    release(d, lock.nonce);
  }
}

/**
 * startNow for a command that already did its own job (`dori backlog add`, `dori done`): an autostart failure becomes
 * one "failed: ..." line and never changes the command's outcome or exit code.
 */
export async function startAfter(d: Deps, by: string, limits?: PullLimits): Promise<string[]> {
  try {
    return await startNow(d, by, limits);
  } catch (e) {
    return [`failed: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/** `dori done`, then the freed slot goes to the next waiting item at once. */
export async function doneThenStart(d: Deps, key: string, limits?: PullLimits): Promise<string[]> {
  await done(d, key);
  return startAfter(d, `autostart after ${key} was done`, limits);
}
