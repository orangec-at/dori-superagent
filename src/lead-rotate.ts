import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { agentCommand } from "./cli-up.ts";
import { shq } from "./delivery.ts";
import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { tellLead } from "./inbox.ts";
import {
  clearRotation,
  handoffPath,
  type LeadRotationConfig,
  type LeadSession,
  loadLeadRotation,
  logRotation,
  type Rotation,
  readRotation,
  readSession,
  writeRotation,
  writeSession,
} from "./lead-rotate-state.ts";
import { refText } from "./refs.ts";
import type { Probe, SessionRef } from "./runtime/types.ts";
import { type Procs, realProcs } from "./self-update-restart.ts";

/** After a rotation or a timed-out handoff, automatic rotation waits this long (the old footer may still be on screen). */
export const QUIET_MS = 60 * 60_000;
/** How long the old agent may take to exit after SIGTERM before the rotation gives up. */
export const STOP_WAIT_MS = 30_000;
const POLL_MS = 500;
const FOOTER_LINES = 10;
const UNITS: Readonly<Record<string, number>> = { "": 1, K: 1_000, M: 1_000_000 };

/** The context size in omo's footer (`638K/1M (63.8%)`), the last one on the screen; undefined when none is shown. */
export function contextTokens(screen: string): number | undefined {
  const m = [...screen.matchAll(/(\d+(?:\.\d+)?)([KM]?)\/\d+(?:\.\d+)?[KM]\s+\(\d/g)].at(-1);
  return m === undefined ? undefined : Math.round(Number(m[1]) * (UNITS[m[2] ?? ""] ?? 1));
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}K`;

/** Why the session should be rotated, or undefined while it is under both limits. */
export function rotationDue(c: LeadRotationConfig, s: LeadSession, now: number): string | undefined {
  if (s.tokens !== undefined && s.tokens >= c.maxTokens)
    return `context ${kTokens(s.tokens)} >= ${kTokens(c.maxTokens)}`;
  const hours = (now - s.startedAt) / 3_600_000;
  if (hours >= c.maxHours) return `session ${Math.floor(hours)}h old >= ${c.maxHours}h`;
  return undefined;
}

export const handoffRequest = (file: string): string =>
  `[LEAD ROTATE] 이 lead 세션은 곧 새 세션으로 교체된다. 새 일은 시작하지 말고, 인수인계 문서를 ${file} 에 써 줘: ` +
  "진행 중인 일(lane, PR, 상태), 기다리는 결정, 답장해야 할 주소([reply=...] 봉투), 다음에 할 일. " +
  "새 세션은 그 문서만 보고 이어서 일한다. 다 쓰면 멈춰.";

/** The lead command `dori up` runs, with the handoff document as its first message. */
const restartCommand = (d: Deps, file: string): string => {
  const header = `[LEAD ROTATED] 이전 lead 세션의 인수인계 문서(${file})다. 읽고 이어서 lead로 일해.`;
  return `${agentCommand(d, "lead.md")} "$(printf '%s\\n\\n' ${shq(header)}; cat ${shq(file)})"`;
};

/** Reads the footer and keeps session.json current; a context that fell below half means a new session was started by hand. */
async function observe(d: Deps, lead: SessionRef, now: number): Promise<LeadSession> {
  const ref = refText(lead);
  const prev = readSession(d.store.root);
  let s: LeadSession = prev?.ref === ref ? prev : { ref, startedAt: now };
  let tokens: number | undefined;
  try {
    tokens = contextTokens(await d.runtimes.for(lead).read(lead, FOOTER_LINES));
  } catch {
    tokens = undefined;
  }
  if (tokens !== undefined) {
    if (s.tokens !== undefined && tokens < s.tokens / 2) s = { ref, startedAt: now };
    s = { ...s, tokens };
  }
  writeSession(d.store.root, s);
  return s;
}

const notify = (d: Deps, now: number, line: string, file: string): void => {
  logRotation(d.store.root, now, line);
  void runHook(d, "onLeadRotation", { key: "lead", text: line, evidence: file });
};

/** Stops the agent in front of the lead pane and starts `dori up`'s lead command there with the handoff as first message. */
async function swap(d: Deps, lead: SessionRef, probe: Probe, file: string, procs: Procs): Promise<void> {
  const agent = basename(d.agentCmd.split(" ")[0] ?? d.agentCmd);
  const pids = (probe.foreground ?? [])
    .filter((p) => p.name === agent || basename(p.argv[0] ?? "") === agent)
    .flatMap((p) => (p.pid === undefined ? [] : [p.pid]));
  if (pids.length === 0) throw new Error(`no ${agent} process in front of the lead pane ${refText(lead)}`);
  for (const pid of pids) procs.kill(pid);
  for (let waited = 0; waited < STOP_WAIT_MS && pids.some(procs.alive); waited += POLL_MS) await procs.sleep(POLL_MS);
  if (pids.some(procs.alive))
    throw new Error(`${agent} in ${refText(lead)} did not exit ${STOP_WAIT_MS / 1000}s after SIGTERM`);
  await d.runtimes.for(lead).start(lead, restartCommand(d, file));
}

/** The handoff phase: swap once the document exists and the lead is idle; give up after `handoffMinutes`. */
async function finishHandoff(
  d: Deps,
  c: LeadRotationConfig,
  lead: SessionRef,
  r: Rotation & { file: string },
  procs: Procs,
): Promise<DutyEvent[]> {
  const root = d.store.root;
  const pane = refText(lead);
  const now = d.now();
  const probe = await d.runtimes.for(lead).probe(lead);
  const written = existsSync(r.file) && statSync(r.file).size > 0;
  const quiet = (s: Partial<LeadSession>) =>
    writeSession(root, { ref: pane, startedAt: now, ...readSession(root), ...s, quietUntil: now + QUIET_MS });
  if (written && probe.status === "idle") {
    try {
      await swap(d, lead, probe, r.file, procs);
    } catch (e) {
      clearRotation(root);
      quiet({});
      const line = `[LEAD ROTATE FAILED] ${pane}: ${e instanceof Error ? e.message : String(e)}; handoff ${r.file}`;
      notify(d, now, line, r.file);
      await tellLead(d, line, "duty");
      return [{ pane, action: "lead-rotate-failed", detail: line }];
    }
    clearRotation(root);
    writeSession(root, { ref: pane, startedAt: now, quietUntil: now + QUIET_MS });
    notify(d, now, `[LEAD ROTATED] ${pane}: ${r.reason}; handoff ${r.file}`, r.file);
    return [{ pane, action: "lead-rotated", detail: `${r.reason}; handoff ${r.file}` }];
  }
  if (now - r.at < c.handoffMinutes * 60_000) return [];
  clearRotation(root);
  quiet({});
  const line = `[LEAD ROTATE TIMEOUT] ${pane}: no handoff at ${r.file} after ${c.handoffMinutes} min; the lead keeps its session (next automatic try in ${QUIET_MS / 60_000} min)`;
  notify(d, now, line, r.file);
  // The hold is lifted first, so this notice and every message queued meanwhile reach the lead.
  await tellLead(d, line, "duty");
  return [{ pane, action: "lead-rotate-timeout", detail: line }];
}

/**
 * One duty pass over the lead (#8): read its context size and age, and when either limit is passed (or `dori lead
 * rotate --now` asked) and the lead is idle, ask it for a handoff document. A later pass that finds the document starts
 * a new agent session in the same pane with it; the role and the inbox stay as they are, and the inbox is held meanwhile.
 */
export async function leadRotationTick(d: Deps, procs: Procs = realProcs): Promise<DutyEvent[]> {
  const root = d.store.root;
  const lead = d.store.roles().lead;
  if (lead === undefined || lead.machine !== undefined) return [];
  const pane = refText(lead);
  let r = readRotation(root);
  if (r !== undefined && r.ref !== pane) {
    clearRotation(root);
    r = undefined;
  }
  const c = loadLeadRotation(root);
  if (r?.phase === "handoff" && r.file !== undefined) return finishHandoff(d, c, lead, { ...r, file: r.file }, procs);
  if (r === undefined && !c.auto) return [];
  const now = d.now();
  const s = await observe(d, lead, now);
  const reason = r?.reason ?? ((s.quietUntil ?? 0) <= now ? rotationDue(c, s, now) : undefined);
  if (reason === undefined) return [];
  const rt = d.runtimes.for(lead);
  if ((await rt.probe(lead)).status !== "idle") return [];
  const file = handoffPath(root, now);
  mkdirSync(dirname(file), { recursive: true });
  const out = await rt.deliver(lead, handoffRequest(file));
  // Typed or ambiguous text may still reach the lead; the handoff wait (and its timeout) covers that too.
  if (out.kind === "no-agent" || out.kind === "not-ready") return [];
  writeRotation(root, { phase: "handoff", ref: pane, at: now, reason, file });
  return [{ pane, action: "lead-handoff-requested", detail: `${reason}; ${file}` }];
}

/** `dori lead rotate --now`: marks the rotation due whatever the limits say, then runs the lead's part of a duty pass. */
export async function rotateNow(d: Deps, procs: Procs = realProcs): Promise<string> {
  const lead = d.store.roles().lead;
  if (lead === undefined) return "LEAD_ROTATE_REFUSED no lead registered (dori role lead)";
  if (lead.machine !== undefined)
    return `LEAD_ROTATE_REFUSED the lead ${refText(lead)} is on machine ${lead.machine}; rotate it there by hand`;
  const pending = readRotation(d.store.root);
  if (pending?.phase === "handoff" && pending.ref === refText(lead))
    return `LEAD_ROTATE_PENDING waiting for the handoff at ${pending.file}`;
  writeRotation(d.store.root, { phase: "due", ref: refText(lead), at: d.now(), reason: "dori lead rotate --now" });
  const [event] = await leadRotationTick(d, procs);
  return event?.action === "lead-handoff-requested"
    ? `LEAD_HANDOFF_REQUESTED ${event.detail ?? ""}`
    : "LEAD_ROTATE_DUE the duty loop asks the lead for its handoff as soon as it is idle";
}
