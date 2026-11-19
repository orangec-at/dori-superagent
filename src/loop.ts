// The hourly loop: sync the backlog with live lanes, audit for missed work, start the next item
// that needs no decision, ask the lead the open questions, and record the run. It never merges,
// never pushes, never closes a pane and never edits a lane record. See docs/hourly-loop.md.
import { log } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { audit, HOUR } from "./loop-audit.ts";
import { autopilotLine } from "./loop-autopilot.ts";
import { checkBoard } from "./loop-board.ts";
import { refreshLinks } from "./loop-links.ts";
import { acquire, release } from "./loop-lock.ts";
import { busyLanes, isOpenLane, pull, settleEnded } from "./loop-pull.ts";
import { markTrialsAsked, routeStanding } from "./standing-loop.ts";
import type { LoopRun } from "./store-types.ts";

export { HOUR };
export const REMIND_HOURS = 6;

export type LoopOpts = {
  interval?: number;
  maxLanes?: number;
  maxStarts?: number;
  maxLoad?: number;
  force?: boolean;
  /** Bound on the 연결 map refresh (default LINKS_TIMEOUT_MS). */
  linksTimeoutMs?: number;
};

const PR_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

async function ghState(d: Deps, kind: "pr" | "issue", repo: string, n: string): Promise<string> {
  const r = await d.exec("gh", [kind, "view", n, "--repo", repo, "--json", "state"]);
  if (r.code !== 0)
    throw new Error(`gh ${kind} view ${repo}#${n}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return String((JSON.parse(r.stdout) as { state?: string }).state);
}

async function sync(d: Deps, run: LoopRun): Promise<void> {
  for (const item of d.store.items()) {
    try {
      if (item.status === "running") {
        const settled = settleEnded(d, item);
        const lane = d.store.lane(item.id);
        if (settled) run.synced.push(settled);
        else if (lane?.status === "ready") {
          const m = lane.final?.evidence.map((e) => PR_RE.exec(e)).find(Boolean);
          if (m && (await ghState(d, "pr", m[1]!, m[2]!)) === "MERGED") {
            item.status = "done";
            log(d, item, "done", "PR merged");
            run.synced.push(`${item.id} done (PR merged)`);
            run.findings.push(`${item.id} READY and its PR merged: dori done ${item.id}`);
          }
        }
      } else if (item.status === "open" && item.source) {
        const [repo, n] = item.source.split("#");
        if ((await ghState(d, "issue", repo!, n!)) === "CLOSED") {
          item.status = "dropped";
          log(d, item, "drop", "source issue closed");
          run.synced.push(`${item.id} dropped (${item.source} closed)`);
        }
      }
    } catch (e) {
      run.findings.push(`gh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function ask(d: Deps, run: LoopRun): void {
  const now = d.now();
  for (const item of d.store.items()) {
    if (item.status !== "open" || !item.decision) continue;
    const line = `[DECIDE ${item.id}] ${item.decision} -> dori backlog decide ${item.id} --text '...' | dori backlog drop ${item.id}`;
    if (item.askedAt === undefined) {
      item.askedAt = now;
      log(d, item, "ask", item.decision);
      run.asked.push(line);
    } else if (item.remindedAt === undefined && now - item.askedAt >= REMIND_HOURS * HOUR) {
      item.remindedAt = now;
      log(d, item, "remind", item.decision);
      run.asked.push(`(reminder) ${line}`);
    }
  }
}

export function summary(run: LoopRun): string {
  if (run.skipped) return `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] skipped: ${run.skipped}`;
  const s = run.status!;
  const lines = [
    `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] lanes ${s.lanes}/${s.maxLanes}${s.adhoc.length ? ` (not from backlog: ${s.adhoc.join(", ")})` : ""}` +
      ` | items open ${s.items.open} (decide ${s.items.decide}) running ${s.items.running}` +
      ` | load ${s.host.load1.toFixed(1)}/${s.host.cores} mem-free ${s.host.memFreePct}%`,
  ];
  if (run.autopilot) lines.push(run.autopilot);
  for (const k of ["synced", "findings", "started", "held"] as const)
    if (run[k].length) lines.push(`${k}: ${run[k].join("; ")}`);
  lines.push(...(run.board ?? []), ...run.asked);
  return lines.join("\n");
}

/** One hourly pass. Skipped runs (stopped, locked, too soon) change nothing and write nothing. */
export async function loopTick(d: Deps, opts: LoopOpts = {}): Promise<LoopRun> {
  const interval = opts.interval ?? HOUR;
  const maxLanes = opts.maxLanes ?? 3;
  const maxStarts = opts.maxStarts ?? 2;
  const empty = { synced: [], findings: [], started: [], held: [], asked: [] };
  const stop = d.store.stop();
  if (stop) return { at: d.now(), skipped: `stopped: ${stop.reason}`, ...empty };
  const lock = acquire(d);
  if ("holder" in lock) return { at: d.now(), skipped: lock.holder, ...empty };
  try {
    const last = d.store.lastRun();
    if (last && !opts.force && d.now() - last.at < interval) {
      return { at: d.now(), skipped: `ran ${Math.floor((d.now() - last.at) / 60_000)}m ago`, ...empty };
    }
    const run: LoopRun = { at: d.now(), synced: [], findings: [], started: [], held: [], asked: [] };
    await sync(d, run);
    await audit(d, run);
    await pull(d, run, { maxLanes, maxStarts, maxLoad: opts.maxLoad }, lock.nonce);
    ask(d, run);
    await routeStanding(d, run);
    run.board = await checkBoard(d);
    const links = await refreshLinks(d, opts.linksTimeoutMs);
    if (links) run.findings.push(links);
    try {
      const line = autopilotLine(d.store.root, run.at);
      if (line) run.autopilot = line;
    } catch (e) {
      run.findings.push(`autopilot line: ${e instanceof Error ? e.message : String(e)}`);
    }
    const items = d.store.items();
    const running = new Set(items.filter((i) => i.status === "running").map((i) => i.id));
    const lanes = d.store.lanes().filter((l) => isOpenLane(l.status));
    run.status = {
      lanes: busyLanes(d),
      maxLanes,
      adhoc: lanes.filter((l) => !running.has(l.key)).map((l) => l.key),
      items: {
        open: items.filter((i) => i.status === "open").length,
        decide: items.filter((i) => i.status === "open" && i.decision).length,
        running: running.size,
      },
      host: d.host(),
    };
    const record = d.store.saveRun(run);
    try {
      if (await tellLead(d, summary(run), "loop")) markTrialsAsked(d, run);
    } catch (e) {
      run.findings.push(`report to the lead failed: ${e instanceof Error ? e.message : String(e)}`);
      d.store.saveRun(run, record);
    }
    return run;
  } finally {
    release(d, lock.nonce);
  }
}

/**
 * How long to sleep: until the last stamp's next hour when that is still ahead (so runs keep their cadence after a
 * restart), otherwise a full interval. A stopped, locked-out or failing loop writes no stamp, so it waits an interval
 * between checks instead of spinning.
 */
export function msUntilNext(d: Deps, interval: number): number {
  const last = d.store.lastRun();
  const due = last ? last.at + interval - d.now() : 0;
  return due > 0 ? Math.max(1000, due) : interval;
}
