// Standing leads: one long-lived session per domain (#vg-lead trial) that owns that domain's backlog items and lanes.
// The lead stays the only session that talks to the human and merges; lane messages of an owned lane go to the
// standing lead, and the lead gets only READY and an ESCALATE summary. A standing lead that is off (never started,
// stopped, or its pane gone) owns nothing, so every message goes to the lead as before.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { sendOrThrow, tellLead } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { formatRef, type SessionRef } from "./runtime/types.ts";
import type { Store } from "./store.ts";
import { KEY_RE, type LoopRun } from "./store-types.ts";

export const DAY = 86_400_000;

/**
 * One entry of `DORI_HOME/leads.json`. A lane or backlog item belongs to the domain when its key starts with one of
 * `keyPrefixes`, its item's `source` is an issue of one of `repos`, or its cwd is one of `cwds` or below it. `bots`:
 * the agents (agents.json names) it may hand work to. `cwd`: where its session opens.
 */
export type StandingLead = {
  readonly domain: string;
  readonly repos: readonly string[];
  readonly keyPrefixes: readonly string[];
  readonly cwds: readonly string[];
  readonly bots: readonly string[];
  readonly trialDays: number;
  readonly cwd?: string;
};

/** `DORI_HOME/leads/<domain>.json`: the running session, or when it was stopped. */
export type LeadState = {
  domain: string;
  sessionRef: SessionRef;
  startedAt: number;
  trialEndsAt: number;
  trialAskedAt?: number;
  stoppedAt?: number;
  stopReason?: string;
};

export const leadsPath = (home: string): string => join(home, "leads.json");
const statePath = (home: string, domain: string): string => join(home, "leads", `${domain}.json`);

const strings = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new Refusal(`${what} must be a string array`);
  return v as string[];
};

/** The configured standing leads; none when leads.json does not exist. A malformed file is refused with what is wrong. */
export function loadLeads(home: string): StandingLead[] {
  const path = leadsPath(home);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Refusal(`${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) throw new Refusal(`${path} must be an array of standing leads`);
  return raw.map((entry: unknown, i): StandingLead => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const at = `${path} entry ${i}`;
    if (typeof e["domain"] !== "string" || !KEY_RE.test(e["domain"]))
      throw new Refusal(`${at}: domain must match ${KEY_RE}`);
    const trialDays = e["trialDays"] ?? 7;
    if (typeof trialDays !== "number" || !(trialDays > 0))
      throw new Refusal(`${at}: trialDays must be a positive number`);
    if (e["cwd"] !== undefined && typeof e["cwd"] !== "string") throw new Refusal(`${at}: cwd must be a string`);
    return {
      domain: e["domain"],
      repos: strings(e["repos"], `${at}: repos`),
      keyPrefixes: strings(e["keyPrefixes"], `${at}: keyPrefixes`),
      cwds: strings(e["cwds"], `${at}: cwds`),
      bots: strings(e["bots"], `${at}: bots`),
      trialDays,
      ...(typeof e["cwd"] === "string" ? { cwd: e["cwd"] } : {}),
    };
  });
}

export function leadDef(home: string, domain: string): StandingLead {
  const leads = loadLeads(home);
  const def = leads.find((l) => l.domain === domain);
  if (!def)
    throw new Refusal(
      `no standing lead ${domain} in ${leadsPath(home)}${leads.length ? ` (known: ${leads.map((l) => l.domain).join(", ")})` : ""}`,
    );
  return def;
}

export function leadState(home: string, domain: string): LeadState | undefined {
  const path = statePath(home, domain);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LeadState) : undefined;
}

export function saveLeadState(home: string, state: LeadState): void {
  mkdirSync(join(home, "leads"), { recursive: true });
  const path = statePath(home, state.domain);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export const isOn = (s: LeadState | undefined): s is LeadState & { stoppedAt?: never } =>
  s !== undefined && s.stoppedAt === undefined;

const under = (cwd: string, dir: string): boolean => cwd === dir || cwd.startsWith(`${dir.replace(/\/+$/, "")}/`);

/** True when the lane or backlog item `key` belongs to the domain (see StandingLead). */
export function owns(store: Store, def: StandingLead, key: string): boolean {
  if (!KEY_RE.test(key)) return false;
  if (def.keyPrefixes.some((p) => key.startsWith(p))) return true;
  const item = store.item(key);
  if (item?.source && def.repos.some((r) => item.source!.startsWith(`${r}#`))) return true;
  const cwd = store.lane(key)?.cwd ?? item?.cwd;
  return cwd !== undefined && def.cwds.some((dir) => under(cwd, dir));
}

/** Open lanes of the domain, for the board and `dori lead status`. */
export const ownedLanes = (store: Store, def: StandingLead): number =>
  store.lanes().filter((l) => l.status !== "done" && l.status !== "lost" && owns(store, def, l.key)).length;

/**
 * The running standing lead that owns `key`, or undefined. A lead whose pane is gone is marked stopped here, and the
 * lead is told once, so routing falls back to the lead from then on.
 */
export async function ownerOf(d: Deps, key: string): Promise<{ domain: string; ref: SessionRef } | undefined> {
  for (const def of loadLeads(d.store.root)) {
    const state = leadState(d.store.root, def.domain);
    if (!isOn(state) || !owns(d.store, def, key)) continue;
    const { status } = await d.runtimes.for(state.sessionRef).probe(state.sessionRef);
    if (status !== "gone") return { domain: def.domain, ref: state.sessionRef };
    saveLeadState(d.store.root, { ...state, stoppedAt: d.now(), stopReason: "pane gone" });
    await tellLead(
      d,
      `[STANDING ${def.domain}] pane ${formatRef(state.sessionRef)} is gone; its lanes report to the lead again (dori lead start ${def.domain} to reopen)`,
      "duty",
    );
  }
  return undefined;
}

/**
 * Sends a lane's message to its standing lead when one owns the lane, else to the lead. `lead`: what the lead still
 * gets of an owned lane's message: "full" (READY: it merges) or "summary" (ESCALATE: the first line, marked as routed).
 * The lead is told first, so a failed standing-lead delivery never costs the lead its copy.
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
  const toLead = lead === "none" ? undefined : await tellLead(d, lead === "full" ? text : summary, from);
  const sent = await sendOrThrow(d, formatRef(owner.ref), text, from);
  return lead === "none" ? sent : toLead;
}

/**
 * The hourly pass's standing-lead part: the [DECIDE] lines of owned items go to their standing lead instead of the
 * lead's summary (a failed delivery keeps them in it), and a trial past its end asks the lead to keep or stop it, once.
 */
export async function routeStanding(d: Deps, run: LoopRun): Promise<void> {
  const keep: string[] = [];
  const routed = new Map<string, { ref: SessionRef; lines: string[] }>();
  for (const line of run.asked) {
    const key = /\[DECIDE ([a-z][a-z0-9-]*)\]/.exec(line)?.[1];
    const owner = key === undefined ? undefined : await ownerOf(d, key);
    if (!owner) keep.push(line);
    else routed.set(owner.domain, { ref: owner.ref, lines: [...(routed.get(owner.domain)?.lines ?? []), line] });
  }
  for (const [domain, { ref, lines }] of routed) {
    try {
      await sendOrThrow(d, formatRef(ref), lines.join("\n"), "loop");
      run.findings.push(`${lines.length} decision(s) sent to standing lead ${domain}`);
    } catch (e) {
      keep.push(...lines);
      run.findings.push(`standing lead ${domain} unreachable (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  run.asked = keep;
  const now = d.now();
  for (const def of loadLeads(d.store.root)) {
    const state = leadState(d.store.root, def.domain);
    if (!isOn(state) || now < state.trialEndsAt || state.trialAskedAt !== undefined) continue;
    saveLeadState(d.store.root, { ...state, trialAskedAt: now });
    const days = Math.round((now - state.startedAt) / DAY);
    run.asked.push(
      `[DECIDE lead-${def.domain}] standing lead ${def.domain} trial ended after ${days} day(s): keep or stop? -> dori lead extend ${def.domain} --days ${def.trialDays} | dori lead stop ${def.domain}`,
    );
  }
}
