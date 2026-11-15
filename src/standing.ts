// Standing leads: one long-lived session per domain that owns that domain's backlog items and lanes. The lead stays the
// only session that talks to the human and merges; lane messages of an owned lane go to the standing lead, and the
// lead gets only READY and an ESCALATE summary. A standing lead that is off (never started, stopped, its pane gone, or
// leads.json unreadable) owns nothing, so every message goes to the lead as before.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { sendOrThrow, tellLead } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { formatRef, type SessionRef } from "./runtime/types.ts";
import type { Store } from "./store.ts";
import { KEY_RE } from "./store-types.ts";

export const DAY = 86_400_000;

/**
 * One entry of `DORI_HOME/leads.json`. A lane or backlog item belongs to the domain when its key starts with one of
 * `keyPrefixes`, its item's `source` is an issue of one of `repos`, or its cwd is one of `cwds` or below it. `bots`:
 * the agents (agents.json names) it may hand work to. `rules`: the domain's own prohibitions, added to its prompt.
 * `cwd`: where its session opens.
 */
export type StandingLead = {
  readonly domain: string;
  readonly repos: readonly string[];
  readonly keyPrefixes: readonly string[];
  readonly cwds: readonly string[];
  readonly bots: readonly string[];
  readonly rules: readonly string[];
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
const invalidMarker = (home: string): string => join(home, "leads", "invalid.txt");

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
      rules: strings(e["rules"], `${at}: rules`),
      trialDays,
      ...(typeof e["cwd"] === "string" ? { cwd: e["cwd"] } : {}),
    };
  });
}

/**
 * loadLeads for the message paths: a malformed leads.json means no standing lead, so lanes, duty and the hourly loop
 * keep working, and the lead is told once per distinct error. Only `dori lead` refuses it.
 */
export async function routingLeads(d: Deps): Promise<StandingLead[]> {
  const marker = invalidMarker(d.store.root);
  try {
    const leads = loadLeads(d.store.root);
    if (existsSync(marker)) rmSync(marker, { force: true });
    return leads;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    if (existsSync(marker) && readFileSync(marker, "utf8") === e.message) return [];
    mkdirSync(join(d.store.root, "leads"), { recursive: true });
    writeFileSync(marker, e.message);
    await tellLead(d, `[STANDING] ${e.message}; every lane reports to the lead until it is fixed`, "duty").catch(
      (err: unknown) =>
        process.stderr.write(`dori: could not tell the lead leads.json is invalid: ${failureDetail(err)}\n`),
    );
    return [];
  }
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

/** The domain's state, or undefined when there is none; an unreadable file reads as off, with one stderr line. */
export function leadState(home: string, domain: string): LeadState | undefined {
  const path = statePath(home, domain);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LeadState;
  } catch (e) {
    process.stderr.write(`dori: ${path} is unreadable (${failureDetail(e)}); standing lead ${domain} counts as off\n`);
    return undefined;
  }
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
 * Marks the standing lead stopped and hands everything still queued for it to the lead, so nothing is lost. With no
 * lead registered the messages stay in its inbox (`dori inbox list <ref>`), with one stderr line.
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
  } finally {
    d.store.saveInbox(ref, []);
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
 * The lead is told first. A standing lead whose pane closed meanwhile is retired, which hands the message to the lead;
 * any other failure to reach it is the caller's (like tellLead) unless the lead already has its copy.
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
  try {
    const sent = await sendOrThrow(d, formatRef(owner.ref), text, from);
    return lead === "none" ? sent : toLead;
  } catch (e) {
    if (e instanceof Refusal) {
      // The lead already has this one: drop it from the dead inbox so retire does not hand it over twice.
      if (lead !== "none")
        d.store.saveInbox(
          owner.ref,
          d.store.queued(owner.ref).filter((m) => m.from !== from || m.text !== text),
        );
      const state = leadState(d.store.root, owner.domain);
      if (isOn(state)) await retire(d, state, "pane gone");
      return toLead;
    }
    if (lead === "none") throw e;
    process.stderr.write(`dori: standing lead ${owner.domain} did not get ${key}'s message: ${failureDetail(e)}\n`);
    return toLead;
  }
}
