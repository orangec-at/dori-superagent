import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Args, need, one, USAGE } from "./cli-args.ts";
import { shq } from "./delivery.ts";
import { prompt, type Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { rotateNow } from "./lead-rotate.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession } from "./runtime/types.ts";
import {
  DAY,
  isOn,
  leadDef,
  leadState,
  loadLeads,
  ownedLanes,
  saveLeadState,
  type LeadState,
  type StandingLead,
} from "./standing.ts";

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

function runningState(d: Deps, domain: string): LeadState {
  leadDef(d.store.root, domain);
  const state = leadState(d.store.root, domain);
  if (!isOn(state)) throw new Refusal(`standing lead ${domain} is not running (dori lead start ${domain})`);
  return state;
}

function renderPrompt(d: Deps, def: StandingLead, trialEndsAt: number): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "(none)");
  const text = prompt(
    "standing-lead.md",
    {
      dori: d.doriCmd,
      domain: def.domain,
      repos: list(def.repos),
      keyPrefixes: list(def.keyPrefixes),
      cwds: list(def.cwds),
      bots: list(def.bots),
      trialEnds: day(trialEndsAt),
    },
    d.store.root,
  );
  const out = join(dir, `standing-lead-${def.domain}.md`);
  writeFileSync(out, text);
  return out;
}

/**
 * Opens the domain's standing lead in a tab beside the caller (or a new "dori" workspace) and records it. A restart
 * before the trial's end keeps that end; otherwise the trial runs trialDays from now.
 */
export async function startStanding(d: Deps, domain: string, opts: { group?: string } = {}): Promise<LeadState> {
  const def = leadDef(d.store.root, domain);
  const old = leadState(d.store.root, domain);
  if (isOn(old)) throw new Refusal(`standing lead ${domain} is already running in ${refText(old.sessionRef)}`);
  const now = d.now();
  const trialEndsAt =
    old && old.trialAskedAt === undefined && old.trialEndsAt > now ? old.trialEndsAt : now + def.trialDays * DAY;
  const rt = d.runtimes.default;
  const cwd = resolve(def.cwd ?? process.cwd());
  const self = d.runtimes.selfAny(process.env);
  const group =
    opts.group ??
    (self?.runtime === rt.kind ? self.group : undefined) ??
    (rt.kind === "herdr" ? await rt.createGroup("dori", cwd) : groupId(d.store.root));
  const kickoff = `You are the standing lead for ${domain}. Follow your system prompt: read the backlog and the open ${domain} lanes, then wait for their messages.`;
  const sessionRef = await openSession(
    rt,
    {
      name: `lead-${domain}`,
      role: "lane",
      container: "tab",
      cwd,
      env: { DORI_HOME: d.store.root, DORI_LANE: `lead-${domain}` },
      ...(group !== undefined ? { group } : {}),
    },
    `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, def, trialEndsAt))} ${shq(kickoff)}`,
  );
  const state: LeadState = { domain, sessionRef, startedAt: now, trialEndsAt };
  saveLeadState(d.store.root, state);
  return state;
}

/** Closes the session and marks it stopped; anything still queued for it goes to the lead, so nothing is lost. */
export async function stopStanding(d: Deps, domain: string, reason: string): Promise<void> {
  const state = runningState(d, domain);
  const rt = d.runtimes.for(state.sessionRef);
  if ((await rt.probe(state.sessionRef)).status !== "gone") await rt.close(state.sessionRef);
  saveLeadState(d.store.root, { ...state, stoppedAt: d.now(), stopReason: reason });
  const left = d.store.queued(state.sessionRef);
  d.store.saveInbox(state.sessionRef, []);
  if (left.length > 0)
    await tellLead(
      d,
      `[STANDING ${domain}] stopped with ${left.length} unread message(s):\n\n${left.map((m) => `from ${m.from}: ${m.text}`).join("\n\n")}`,
      "duty",
    );
}

export function extendStanding(d: Deps, domain: string, days: number): LeadState {
  if (!(days > 0)) throw new Refusal("--days must be a positive number");
  const { trialAskedAt: _, ...rest } = runningState(d, domain);
  const state = { ...rest, trialEndsAt: d.now() + days * DAY };
  saveLeadState(d.store.root, state);
  return state;
}

export function standingLines(d: Deps): string[] {
  const now = d.now();
  return loadLeads(d.store.root).map((def) => {
    const s = leadState(d.store.root, def.domain);
    const lanes = ownedLanes(d.store, def);
    if (!isOn(s)) return `${def.domain} off${s?.stopReason ? ` (${s.stopReason})` : ""} lanes ${lanes}`;
    const left = Math.max(0, Math.ceil((s.trialEndsAt - now) / DAY));
    return `${def.domain} on pane=${refText(s.sessionRef)} trial ${left}d left (ends ${day(s.trialEndsAt)}) lanes ${lanes}`;
  });
}

export async function runLead(d: Deps, a: Args, x: string | undefined): Promise<number> {
  const domain = a.pos[2];
  switch (x) {
    case "rotate": {
      if (one(a, "now") !== "true") break;
      const line = await rotateNow(d);
      console.log(line);
      return line.startsWith("LEAD_ROTATE_REFUSED") ? 2 : 0;
    }
    case "start": {
      const s = await startStanding(d, need(domain, "domain"));
      console.log(`LEAD_STARTED ${s.domain} pane=${refText(s.sessionRef)} trial-ends=${day(s.trialEndsAt)}`);
      return 0;
    }
    case "stop":
      await stopStanding(d, need(domain, "domain"), one(a, "text") ?? "stopped by the lead");
      console.log(`LEAD_STOPPED ${domain}`);
      return 0;
    case "extend": {
      const s = extendStanding(d, need(domain, "domain"), Number(one(a, "days") ?? "7"));
      console.log(`LEAD_EXTENDED ${s.domain} trial-ends=${day(s.trialEndsAt)}`);
      return 0;
    }
    case "status": {
      const lines = standingLines(d);
      if (lines.length === 0) console.log("NO_STANDING_LEADS");
      for (const line of lines) console.log(line);
      return 0;
    }
  }
  throw new Refusal(`usage: dori lead rotate --now | start|stop|extend|status <domain>\n\n${USAGE}`);
}
