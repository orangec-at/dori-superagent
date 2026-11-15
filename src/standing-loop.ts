import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { sendOrThrow } from "./inbox.ts";
import { formatRef, type SessionRef } from "./runtime/types.ts";
import { DAY, isOn, leadState, routingLeads, saveLeadState } from "./standing.ts";
import { ownerOf } from "./standing-route.ts";
import type { LoopRun } from "./store-types.ts";

const TRIAL_RE = /^\[DECIDE lead-([a-z][a-z0-9-]*)\]/;

/**
 * The hourly pass's standing-lead part: the [DECIDE] lines of owned items go to their standing lead instead of the
 * lead's summary (a failed delivery keeps them in it), and a running trial past its end adds a keep-or-stop line.
 * That line is asked until markTrialsAsked records it, after the summary reached the lead.
 */
export async function routeStanding(d: Deps, run: LoopRun): Promise<void> {
  const keep: string[] = [];
  const routed = new Map<string, { ref: SessionRef; lines: string[] }>();
  for (const line of run.asked) {
    const key = /\[DECIDE ([a-z][a-z0-9-]*)\]/.exec(line)?.[1];
    const owner =
      key === undefined
        ? undefined
        : await ownerOf(d, key).catch((e: unknown) => {
            run.findings.push(`standing lead of ${key} unknown (${failureDetail(e)}); asked the lead`);
            return undefined;
          });
    if (!owner) keep.push(line);
    else routed.set(owner.domain, { ref: owner.ref, lines: [...(routed.get(owner.domain)?.lines ?? []), line] });
  }
  for (const [domain, { ref, lines }] of routed) {
    try {
      await sendOrThrow(d, formatRef(ref), lines.join("\n"), "loop");
      run.findings.push(`${lines.length} decision(s) sent to standing lead ${domain}`);
    } catch (e) {
      keep.push(...lines);
      run.findings.push(`standing lead ${domain} unreachable (${failureDetail(e)})`);
    }
  }
  run.asked = keep;
  for (const def of await routingLeads(d)) {
    const state = leadState(d.store.root, def.domain);
    if (!isOn(state) || run.at < state.trialEndsAt || state.trialAskedAt !== undefined) continue;
    const days = Math.round((run.at - state.startedAt) / DAY);
    run.asked.push(
      `[DECIDE lead-${def.domain}] standing lead ${def.domain} trial ended after ${days} day(s): keep or stop? -> dori lead extend ${def.domain} --days ${def.trialDays} | dori lead stop ${def.domain}`,
    );
  }
}

/** Records the trial questions of a summary the lead received, so each is asked once. */
export function markTrialsAsked(d: Deps, run: LoopRun): void {
  for (const line of run.asked) {
    const domain = TRIAL_RE.exec(line)?.[1];
    const state = domain === undefined ? undefined : leadState(d.store.root, domain);
    if (isOn(state) && state.trialAskedAt === undefined)
      saveLeadState(d.store.root, { ...state, trialAskedAt: run.at });
  }
}
