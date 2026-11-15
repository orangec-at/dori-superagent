import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { sendOrThrow, tellLead } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { formatRef, type SessionRef } from "./runtime/types.ts";
import { isOn, type LeadState, leadState, owns, routingLeads, saveLeadState } from "./standing.ts";
import type { QueuedMessage } from "./store-types.ts";

const same = (a: QueuedMessage, b: QueuedMessage): boolean => a.at === b.at && a.from === b.from && a.text === b.text;

function dropFromInbox(d: Deps, ref: SessionRef, batch: readonly QueuedMessage[]): void {
  const release = d.store.lockInbox(ref, d.now());
  try {
    d.store.saveInbox(
      ref,
      d.store.queued(ref).filter((m) => !batch.some((b) => same(b, m))),
    );
  } finally {
    release?.();
  }
}

/**
 * Marks the standing lead stopped and hands everything queued for it to the lead, so nothing is lost. Never throws on
 * the delivery: an uncertain one is already kept in the lead's inbox. With no lead registered the messages stay in the
 * standing lead's inbox (`dori inbox list <ref>`), with one stderr line.
 */
export async function retire(d: Deps, state: LeadState, reason: string): Promise<void> {
  saveLeadState(d.store.root, { ...state, stoppedAt: d.now(), stopReason: reason });
  const ref = state.sessionRef;
  const left = d.store.queued(ref);
  if (!d.store.roles().lead) {
    process.stderr.write(
      `dori: no lead registered; ${left.length} message(s) kept in the inbox of ${formatRef(ref)}\n`,
    );
    return;
  }
  const head = `[STANDING ${state.domain}] ${reason}; its lanes report to the lead again (dori lead start ${state.domain} to reopen)`;
  const unread = left.map((m) => `from ${m.from}: ${m.text}`).join("\n\n");
  try {
    await tellLead(d, left.length ? `${head}\n\n${left.length} unread message(s):\n\n${unread}` : head, "duty");
  } catch (e) {
    process.stderr.write(`dori: telling the lead standing lead ${state.domain} stopped: ${failureDetail(e)}\n`);
  } finally {
    dropFromInbox(d, ref, left);
  }
}

/** The running standing lead that owns `key`, or undefined. One whose pane is gone is retired here. */
export async function ownerOf(d: Deps, key: string): Promise<{ domain: string; ref: SessionRef } | undefined> {
  for (const def of await routingLeads(d)) {
    const state = leadState(d.store.root, def.domain);
    if (!isOn(state) || !owns(d.store, def, key)) continue;
    const { status } = await d.runtimes.for(state.sessionRef).probe(state.sessionRef);
    if (status !== "gone") return { domain: def.domain, ref: state.sessionRef };
    await retire(d, state, "pane gone");
  }
  return undefined;
}

/**
 * Sends a lane's message to its standing lead when one owns the lane, else to the lead. `lead`: what the lead still
 * gets of an owned lane's message: "full" (READY: it merges) or "summary" (ESCALATE: the first line, marked as routed).
 * The lead is told first; its failure is rethrown only after the standing lead was tried. A standing lead whose pane
 * closed meanwhile is retired, and the lead gets the full text unless it already has it; any other failure to reach
 * the standing lead is the caller's (like tellLead) unless the lead has its copy.
 */
export async function tellOwner(
  d: Deps,
  key: string,
  text: string,
  from: string,
  lead: "none" | "full" | "summary" = "none",
): Promise<"DELIVERED" | "QUEUED" | undefined> {
  const owner = await ownerOf(d, key);
  if (!owner) return tellLead(d, text, from);
  const summary = `${(text.split("\n")[0] ?? "").slice(0, 200)} (sent to standing lead ${owner.domain})`;
  let toLead: "DELIVERED" | "QUEUED" | undefined;
  let leadFailure: { error: unknown } | undefined;
  if (lead !== "none") {
    try {
      toLead = await tellLead(d, lead === "full" ? text : summary, from);
    } catch (error) {
      leadFailure = { error };
    }
  }
  const done = (sent: "DELIVERED" | "QUEUED" | undefined) => {
    if (leadFailure) throw leadFailure.error;
    return lead === "none" ? sent : toLead;
  };
  try {
    return done(await sendOrThrow(d, formatRef(owner.ref), text, from));
  } catch (e) {
    if (e === leadFailure?.error) throw e;
    if (!(e instanceof Refusal)) {
      if (lead === "none") throw e;
      process.stderr.write(`dori: standing lead ${owner.domain} did not get ${key}'s message: ${failureDetail(e)}\n`);
      return done(undefined);
    }
    const state = leadState(d.store.root, owner.domain);
    const mine = d.store.queued(owner.ref).filter((m) => m.from === from && m.text === text);
    // retire hands the dead inbox to the lead: this message goes with it unless the lead already has it in full or
    // another caller retired the lead first (then it is handed over here).
    if (lead === "full" || !isOn(state)) dropFromInbox(d, owner.ref, mine);
    if (isOn(state)) await retire(d, state, "pane gone");
    else if (lead !== "full") return done(await tellLead(d, text, from));
    return done(undefined);
  }
}
