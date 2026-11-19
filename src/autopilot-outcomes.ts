// What became of each delegation the autopilot handed out. A delegation that failed, timed out or never started is
// released, so its task can be handed out again, and the lead is told; after MAX_RELEASES it stays held instead. One
// that ended ok has its roadmap line checked off when its outputs are there (autopilot-checkoff.ts).
import { type Agent, loadAgents } from "./agents.ts";
import { checkOff, type FreshCheck, freshHere } from "./autopilot-checkoff.ts";
import { RemoteBudget, remoteFresh } from "./autopilot-remote.ts";
import {
  type Assignment,
  assignmentKey,
  assignmentState,
  delegateEnds,
  delegateRuns,
  readAssignments,
  recordAssignment,
} from "./autopilot-store.ts";
import type { Deps } from "./harness.ts";
import type { Roadmap } from "./roadmap.ts";

export const MAX_RELEASES = 2;
/** A delegation with no start line this long after it was handed out never ran (its process could not start). */
export const NEVER_STARTED_MS = 15 * 60_000;

/** The marker every autopilot delegation text opens with, so its start and end lines can be found again. */
export const taskTag = (project: string, task: string): string => `[autopilot ${project} ${task}]`;

/** "ok", a failure outcome, or undefined while the delegation may still be running. */
function outcomeOf(d: Deps, a: Assignment): string | undefined {
  const home = d.store.root;
  const tag = taskTag(a.project, a.task);
  const ours = (x: { agent: string; text: string; at: number }) =>
    x.agent === a.bot && x.text.startsWith(tag) && x.at >= a.at;
  const end = delegateEnds(home).findLast(ours);
  if (end !== undefined) return end.outcome;
  const start = delegateRuns(home).findLast(ours);
  if (start !== undefined) return start.until < d.now() ? "lost (no end recorded)" : undefined;
  return d.now() - a.at >= NEVER_STARTED_MS ? "never started" : undefined;
}

/** The bots agents.json names; undefined when it cannot be read (no ok delegation is checked off then). */
function agentsOrNone(home: string): Agent[] | undefined {
  try {
    return loadAgents(home);
  } catch {
    return undefined;
  }
}

/** Checks every delegation still held: releases the failed ones, checks off the verified ones; one lead line each. */
export async function checkOutcomes(d: Deps, roadmaps: readonly Roadmap[]): Promise<string[]> {
  const home = d.store.root;
  const { latest, releases } = assignmentState(readAssignments(home));
  const agents = agentsOrNone(home);
  const budget = new RemoteBudget();
  try {
    return await sweep();
  } finally {
    budget.stop();
  }

  async function sweep(): Promise<string[]> {
    const out: string[] = [];
    for (const a of latest.values()) {
      if (a.kind !== "delegate") continue;
      const outcome = outcomeOf(d, a);
      // A bot agents.json does not name (or no readable agents.json) is never guessed to be on this machine.
      const bot = agents?.find((x) => x.name === a.bot);
      if (outcome === "ok" && bot !== undefined) {
        const fresh: FreshCheck =
          bot.host === "" ? freshHere : (paths, since) => remoteFresh(d.exec, bot.host, paths, since, budget);
        const line = await checkOff(d, a, roadmaps, fresh);
        if (line !== undefined) out.push(line);
      }
      if (outcome === undefined || outcome === "ok") continue;
      out.push(release(a, outcome));
    }
    return out;
  }

  function release(a: Assignment, outcome: string): string {
    const final = (releases.get(assignmentKey(a)) ?? 0) + 1 >= MAX_RELEASES;
    recordAssignment(home, { ...a, at: d.now(), kind: "release", outcome, ...(final ? { final } : {}) });
    return (
      `[AUTOPILOT 실패] ${a.bot} ${a.project}: ${a.text} (${outcome}) -> ` +
      (final ? `${MAX_RELEASES}번 실패해 멈춤: 로드맵에서 고치거나 [x]로 닫아 주세요` : "다시 배정 대기")
    );
  }
}
