import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";
import { doriHost, laneFooter } from "./remote.ts";
import { groupId } from "./runtime/group.ts";
import { openSession } from "./runtime/types.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";

/** Refuses a key no new lane may take: a bad shape, a role name, or a lane that is still open. */
export function checkNewKey(d: Deps, key: string): void {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost")
    throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
}

/**
 * `machine`: open the lane on that saved herdr SSH machine, in a new "dori" workspace there. `cwd` is then a directory
 * on that machine and must be given; the agent reads its brief and calls dori over ssh back to this machine.
 */
export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string; machine?: string } = {},
): Promise<Lane> {
  checkNewKey(d, key);
  const { machine } = opts;
  const rt = d.runtimes.default;
  if (machine !== undefined && rt.kind !== "herdr") throw new Refusal("--machine needs the herdr runtime");
  if (machine !== undefined && opts.cwd === undefined)
    throw new Refusal(`--machine needs --cwd: a directory on ${machine}`);
  const cwd = machine !== undefined ? (opts.cwd ?? "") : resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = laneFooter(d, key, machine);
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  // The group is the caller's own when it runs in a session of the selected runtime (a lane opened from the lead's
  // workspace stays there); otherwise herdr gets a new "dori" workspace and hc this home's group label. A lane on
  // another machine always gets a "dori" workspace there: no local workspace exists on it.
  const self = d.runtimes.selfAny(process.env);
  const group =
    opts.group ??
    (machine === undefined && self?.runtime === rt.kind ? self.group : undefined) ??
    (rt.kind === "herdr" ? await rt.createGroup("dori", cwd, machine) : groupId(d.store.root));
  const kickoff =
    machine === undefined
      ? `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`
      : `Read your brief with \`ssh ${doriHost()} cat ${shq(briefPath)}\` and execute it. Your lane key is ${key}.`;
  const env = { DORI_LANE: key, ...(machine === undefined ? { DORI_HOME: d.store.root } : {}) };
  const ref = await openSession(
    rt,
    { name: key, role: "lane", container: "tab", cwd, env, group, ...(machine !== undefined ? { machine } : {}) },
    `${d.agentCmd} ${shq(kickoff)}`,
  );

  const now = d.now();
  const lane: Lane = {
    key,
    sessionRef: ref,
    paneId: ref.id,
    tabId: ref.container ?? "",
    brief: briefPath,
    cwd,
    status: "working",
    createdAt: now,
    lastActivityAt: now,
    nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(
  d: Deps,
  key: string,
  text: string,
  status?: "working" | "waiting",
): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: "" });
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(
  d: Deps,
  key: string,
  text: string,
  evidence: readonly string[],
): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  // An adopted pane was the operator's before dori watched it: the lane ends, the session stays.
  if (!lane.adopted) {
    const rt = d.runtimes.for(lane.sessionRef);
    const { status: st } = await rt.probe(lane.sessionRef);
    if (st === "working" || st === "blocked" || st === "error")
      throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
    if (st !== "gone") await rt.close(lane.sessionRef);
  }
  lane.status = "done";
  lane.log.push({
    at: d.now(),
    kind: "done",
    text: lane.adopted ? "lane ended by lead; pane left open" : "closed by lead",
  });
  d.store.saveLane(lane);
}
