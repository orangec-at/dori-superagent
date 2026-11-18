// Pull: start the next backlog items that need no decision, within the lane, load and memory limits. The hourly loop
// runs it once an hour; autostart.ts runs it right after `dori backlog add`, `dori done` and on each duty pass.
import { readFileSync, writeFileSync } from "node:fs";
import { log } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { startLane } from "./lanes.ts";
import { holds } from "./loop-lock.ts";
import { refText } from "./refs.ts";
import type { Item, LoopRun } from "./store-types.ts";

export const MAX_ATTEMPTS = 2;
export const MEM_FREE_MIN_PCT = 10;

export const isOpenLane = (status: string): boolean => status !== "done" && status !== "lost";

/**
 * Lanes holding one of the loop's slots: backlog lanes still at work. A READY lane waits only for the human's merge,
 * and an ad-hoc lane (no running backlog item, opened by the lead) is not the loop's, so neither keeps the backlog
 * from moving. The host load and memory checks still bound how many lanes run at once.
 */
export function busyLanes(d: Deps): number {
  const running = new Set(
    d.store
      .items()
      .filter((i) => i.status === "running")
      .map((i) => i.id),
  );
  return d.store.lanes().filter((l) => isOpenLane(l.status) && l.status !== "ready" && running.has(l.key)).length;
}

/**
 * Moves a running item out of running once its lane has ended, whoever opened it (hourly loop, autostart, by hand):
 * done when the lane is done, open again with one more attempt when it was lost or its record is gone. Returns the
 * line for a run's `synced`, or undefined while the lane is still open.
 */
export function settleEnded(d: Deps, item: Item): string | undefined {
  if (item.status !== "running") return undefined;
  const lane = d.store.lane(item.id);
  if (lane?.status === "done") {
    item.status = "done";
    log(d, item, "done", "lane done");
    return `${item.id} done (lane done)`;
  }
  if (lane && lane.status !== "lost") return undefined;
  const why = lane ? "lane lost" : "lane record missing";
  item.status = "open";
  item.attempts += 1;
  if (item.attempts >= MAX_ATTEMPTS) item.decision = `${why} ${item.attempts} times; retry, re-brief or drop?`;
  log(d, item, "reopen", `${why}, attempt ${item.attempts}`);
  return `${item.id} reopened (${why}, attempt ${item.attempts})`;
}

/** Open items with no decision and no open lane, first to start first: priority, then age, then id. */
export const pullCandidates = (d: Deps) =>
  d.store
    .items()
    .filter((i) => i.status === "open" && !i.decision && !isOpenLane(d.store.lane(i.id)?.status ?? "done"))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

export type PullLimits = { maxLanes: number; maxStarts: number; maxLoad: number | undefined };

/** The limits the running `dori loop` was started with (its flags or env), so autostart keeps to the same ones. */
export function saveLoopLimits(d: Deps, lim: PullLimits): void {
  writeFileSync(d.store.loopPath("limits.json"), `${JSON.stringify(lim)}\n`);
}

/** What saveLoopLimits wrote; undefined when no loop has run in this home or the file is unreadable. */
export function loopLimits(d: Deps): PullLimits | undefined {
  try {
    const v = JSON.parse(readFileSync(d.store.loopPath("limits.json"), "utf8")) as Partial<PullLimits>;
    if (typeof v.maxLanes !== "number" || typeof v.maxStarts !== "number") return undefined;
    return {
      maxLanes: v.maxLanes,
      maxStarts: v.maxStarts,
      maxLoad: typeof v.maxLoad === "number" ? v.maxLoad : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * `by`: who opened the lane, for the item's log ("the hourly loop", "autostart after backlog add", ...).
 * `retryAfterMs`: for callers that pull every minute (autostart). A failed start is then not counted toward
 * MAX_ATTEMPTS, which is sized for one try an hour, and the item is not tried again until this much time has passed.
 */
export type PullOpts = { readonly by?: string; readonly retryAfterMs?: number };

const lastFailedStart = (item: Item): number =>
  item.log.findLast((e) => e.kind === "start" && e.text.startsWith("failed"))?.at ?? Number.NEGATIVE_INFINITY;

export async function pull(d: Deps, run: LoopRun, lim: PullLimits, nonce: string, opts: PullOpts = {}) {
  const by = opts.by ?? "the hourly loop";
  const retry = opts.retryAfterMs;
  if (!d.store.roles().lead) {
    run.held.push("no lead pane registered");
    return;
  }
  const host = d.host();
  const open = busyLanes(d);
  let starts = Math.max(0, Math.min(lim.maxLanes - open, lim.maxStarts));
  const candidates = pullCandidates(d).filter((i) => retry === undefined || d.now() - lastFailedStart(i) >= retry);
  const maxLoad = lim.maxLoad ?? host.cores;
  if (candidates.length > 0 && (host.load1 > maxLoad || host.memFreePct < MEM_FREE_MIN_PCT)) {
    run.held.push(`host busy: load ${host.load1.toFixed(1)} (limit ${maxLoad}), mem free ${host.memFreePct}%`);
    starts = 0;
  }
  // Each start attempt uses one of this run's slots, so a broken host costs at most `starts` failures per run.
  // A failed item counts toward MAX_ATTEMPTS and then becomes a question, so it never blocks the items behind it.
  let tried = 0;
  for (; tried < Math.min(starts, candidates.length); tried++) {
    const item = candidates[tried]!;
    if (!holds(d, nonce)) {
      run.held.push("lock lost to another loop; no more starts this run");
      break;
    }
    try {
      await startLane(d, item.id, item.brief, { cwd: item.cwd });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const lane = d.store.lane(item.id);
      if ((!lane || !isOpenLane(lane.status) || lane.createdAt < run.at) && retry !== undefined) {
        log(d, item, "start", `failed (${by}; not counted, retried after ${Math.round(retry / 60_000)}m): ${why}`);
        run.findings.push(`start ${item.id} failed: ${why}`);
        continue;
      }
      if (!lane || !isOpenLane(lane.status) || lane.createdAt < run.at) {
        item.startFailures = (item.startFailures ?? 0) + 1;
        if (item.startFailures >= MAX_ATTEMPTS)
          item.decision = `lane start failed ${item.startFailures} times (${why.slice(0, 120)}); fix the brief or cwd, or drop?`;
        log(d, item, "start", `failed: ${why}`);
        run.findings.push(`start ${item.id} failed: ${why}`);
        continue;
      }
      run.findings.push(`${item.id} started in ${refText(lane.sessionRef)} but the lead was not told: ${why}`);
    }
    item.status = "running";
    log(d, item, "start", `lane opened by ${by}`);
    run.started.push(`${item.id} (p${item.priority})`);
  }
  const waiting = candidates.length - tried;
  if (waiting > 0) {
    run.held.push(
      `${waiting} item(s) waiting: ${Math.max(0, lim.maxLanes - open - run.started.length)} free of ${lim.maxLanes} lanes, max ${lim.maxStarts}/run`,
    );
  }
}
