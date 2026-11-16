// Pull: start the next backlog items that need no decision, within the lane, load and memory limits. The hourly loop
// runs it once an hour; autostart.ts runs it right after `dori backlog add`, `dori done` and on each duty pass.
import { log } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { startLane } from "./lanes.ts";
import { holds } from "./loop-lock.ts";
import { refText } from "./refs.ts";
import type { LoopRun } from "./store-types.ts";

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

/** Open items with no decision and no open lane, first to start first: priority, then age, then id. */
export const pullCandidates = (d: Deps) =>
  d.store
    .items()
    .filter((i) => i.status === "open" && !i.decision && !isOpenLane(d.store.lane(i.id)?.status ?? "done"))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

export type PullLimits = { maxLanes: number; maxStarts: number; maxLoad: number | undefined };

/** `by`: who opened the lane, for the item's log ("the hourly loop", "autostart after backlog add", ...). */
export async function pull(d: Deps, run: LoopRun, lim: PullLimits, nonce: string, by = "the hourly loop") {
  if (!d.store.roles().lead) {
    run.held.push("no lead pane registered");
    return;
  }
  const host = d.host();
  const open = busyLanes(d);
  let starts = Math.max(0, Math.min(lim.maxLanes - open, lim.maxStarts));
  const candidates = pullCandidates(d);
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
