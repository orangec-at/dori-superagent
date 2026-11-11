import { COST_SCREEN_LINES, limitFor, loadBudgets, noteCost } from "./budget.ts";
import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { flushInbox, isHeld, sendOrThrow, tellLead } from "./inbox.ts";
import { leadRotationTick } from "./lead-rotate.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { nudgeText } from "./remote.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Lane } from "./store-types.ts";

export const NUDGE_MINUTES = [10, 20, 40] as const;

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** An open lane the duty loop watches; a lane being migrated is left alone (no nudge, no lost, no activity stamp). */
const watched = (lane: Lane): boolean =>
  (lane.status === "working" || lane.status === "waiting") && lane.migration !== true;

/** The pane's screen for its cost, or undefined when it cannot be read: the lane then keeps its last cost (#3). */
const screenOf = (d: Deps, ref: SessionRef): Promise<string | undefined> =>
  d.runtimes
    .for(ref)
    .read(ref, COST_SCREEN_LINES)
    .catch(() => undefined);

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  // The lead's rotation first (#8): a pass that asks for a handoff holds the lead's inbox before it is flushed below.
  try {
    events.push(...(await leadRotationTick(d)));
  } catch (e) {
    events.push({ pane: "lead", action: "lead-rotate-failed", detail: failureDetail(e) });
  }
  for (const ref of d.store.inboxPanes()) {
    const paneId = refText(ref);
    try {
      const result = await flushInbox(d, ref);
      // flushInbox follows a `.forward` marker; the counts are read where the entries live now.
      const at = d.store.forwardOf(ref) ?? ref;
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({
          pane: paneId,
          action: "inbox-held",
          detail: `no agent in front; ${d.store.queued(at).length} message(s) kept`,
        });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(at).filter(isHeld).length;
      if (held > 0)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const listed of d.store.lanes()) {
    if (!watched(listed)) continue;
    try {
      const { status: st } = await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
      const screen = st === "gone" ? undefined : await screenOf(d, listed.sessionRef);
      // Re-read right before deciding and saving: a report, a READY or a migration may have landed during the probe.
      const lane = d.store.lane(listed.key);
      if (lane === undefined || !watched(lane) || lane.sessionRef.id !== listed.sessionRef.id) continue;
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        void runHook(d, "onLost", { key: lane.key, text: "pane disappeared without READY", evidence: "" });
        await tellLead(d, `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      const alert = noteCost(lane, screen, limitFor(loadBudgets(d.store.root), lane.key), now);
      if (lane.costAt === now) d.store.saveLane(lane);
      if (alert !== undefined) {
        await tellLead(d, alert, "duty");
        events.push({ lane: lane.key, action: lane.budgetAlert === "over" ? "budget-over" : "budget-80" });
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
        continue;
      }
      // A lane over its budget is never nudged or escalated (the lead was told OVER), and never stopped either.
      if (lane.status === "waiting" || st === "blocked" || st === "error" || lane.budgetAlert === "over") continue;
      const idleMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || idleMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await sendOrThrow(d, lane.key, nudgeText(d, lane.key, Math.floor(idleMin), lane.sessionRef.machine), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(
          d,
          `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges` +
            (lane.sessionRef.machine ? ` (remote lane: its ssh report command may be failing)` : ""),
          "duty",
        );
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: listed.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
  });
  return events;
}
