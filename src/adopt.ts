import { readFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import { send, settled, tellLead, type SendResult } from "./inbox.ts";
import { checkNewKey } from "./lanes.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { laneFooter } from "./remote.ts";
import { MACHINE_RE, parseRef, type SessionRef } from "./runtime/types.ts";
import type { Lane } from "./store-types.ts";

export type AdoptOptions = { machine?: string; brief?: string; note?: string; cwd?: string };

function paneRef(pane: string, machine: string | undefined): SessionRef {
  const ref = parseRef(pane);
  if (ref === undefined) throw new Refusal(`${pane} is not a session ref (w1:p3, w4:p3@ubuntu, herdr:w1:p3 or hc:t7)`);
  if (machine === undefined) return ref;
  if (!MACHINE_RE.test(machine)) throw new Refusal(`--machine ${machine} is not a herdr machine label`);
  if (ref.runtime !== "herdr") throw new Refusal("--machine needs a herdr pane");
  if (ref.machine !== undefined && ref.machine !== machine)
    throw new Refusal(`${pane} names machine ${ref.machine}, not ${machine}`);
  return { ...ref, machine };
}

/**
 * Registers an agent session dori did not open (omo or Claude Code, here or on a saved herdr machine) as lane `key`:
 * the duty loop then watches, nudges and escalates it like any lane, and its reports go to the lead. The brief file,
 * the note and the lane rules are written to the lane's brief and delivered to the pane once, through its inbox, so a
 * busy agent is never interrupted. Refuses a pane that is gone or has no agent, and one another open lane runs in.
 */
export async function adoptLane(
  d: Deps,
  key: string,
  pane: string,
  opts: AdoptOptions = {},
): Promise<{ lane: Lane; sent: SendResult | undefined }> {
  checkNewKey(d, key);
  const ref = paneRef(pane, opts.machine);
  const taken = d.store
    .lanes()
    .find((l) => l.status !== "done" && l.status !== "lost" && sameSession(l.sessionRef, ref));
  if (taken) throw new Refusal(`${refText(ref)} is already lane ${taken.key}`);
  const probe = await d.runtimes.for(ref).probe(ref, { omoWithoutAgent: true });
  if (probe.status === "gone") throw new Refusal(`pane ${refText(ref)} is gone`);
  if (probe.status === "shell") throw new Refusal(`pane ${refText(ref)} has no agent running; adopt an agent session`);

  const parts = [
    opts.brief !== undefined ? readFileSync(opts.brief, "utf8").trimEnd() : undefined,
    opts.note?.trim() || undefined,
  ].filter((p): p is string => p !== undefined);
  const task = parts.length > 0 ? parts.join("\n\n") : "Continue the task already in progress in this session.";
  const footer = laneFooter(d, key, ref.machine);
  const briefPath = d.store.briefPath(key);
  await Bun.write(briefPath, `${task}\n\n${footer}`);

  const now = d.now();
  const lane: Lane = {
    key,
    sessionRef: ref,
    paneId: ref.id,
    tabId: ref.container ?? "",
    brief: briefPath,
    cwd: opts.cwd ?? probe.cwd ?? "",
    status: "working",
    adopted: true,
    createdAt: now,
    lastActivityAt: now,
    nudges: 0,
    log: [{ at: now, kind: "adopt", text: refText(ref) }],
  };
  d.store.saveLane(lane);
  const intro = `[dori] This session is now lane ${key}: dori's duty loop watches it and your reports go to the lead. Keep your current work going; from now on follow these rules.`;
  const sent = await send(d, key, `${intro}\n\n${task}\n\n${footer}`, "dori");
  await settled(tellLead(d, `[ADOPT ${key}] lane adopted in ${refText(ref)}`, key));
  return { lane, sent };
}
