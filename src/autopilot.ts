// The autopilot, run on each duty pass: a bot idle for hours gets the next task of a project it owns, and a project
// silent for a day is reported to the lead and handed its next task. Every hand-out is recorded, and status.json
// shows the whole picture to the board. See docs/autopilot.md.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadAgents } from "./agents.ts";
import { checkOutcomes } from "./autopilot-outcomes.ts";
import {
  assignmentState,
  autopilotDir,
  autopilotStopped,
  botActivity,
  delegateRuns,
  readAssignments,
  readState,
  recordAssignment,
  writeJson,
} from "./autopilot-store.ts";
import { noWorkReport } from "./autopilot-idle.ts";
import { delegateText, handOut, lastActivity, nextTask, STALL_HOURS, taskBot } from "./autopilot-stall.ts";
import { CLI, type Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { loadRoadmaps, type Roadmap } from "./roadmap.ts";
import { KEY_RE } from "./store-types.ts";

const HOUR = 3_600_000;
export const IDLE_CHECK_MS = 10 * 60_000;
export const STALL_CHECK_MS = HOUR;
const DELEGATE_TIMEOUT_S = 1800;

/** How long a bot may sit idle before it is handed work: DORI_IDLE_HOURS, default 2. */
export const idleHours = (): number => {
  const v = Number(process.env["DORI_IDLE_HOURS"]);
  return Number.isFinite(v) && v > 0 ? v : 2;
};

/**
 * Quiet hours in Korea, from DORI_QUIET_HOURS: unset, "", "off" or "none" means none (the default: 24 hours a day);
 * "A-B" means A:00 to B:00 KST, wrapping past midnight when A > B ("22-6"). Any other value falls back to "1-8".
 */
export const quietHours = (): [number, number] | undefined => {
  const v = (process.env["DORI_QUIET_HOURS"] ?? "").trim().toLowerCase();
  if (v === "" || v === "off" || v === "none") return undefined;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
  const from = Number(m?.[1]);
  const to = Number(m?.[2]);
  return from <= 23 && to <= 24 && from !== to ? [from, to] : [1, 8];
};

/** Inside the quiet hours nobody is handed work and no stall is reported. */
export const quietHour = (now: number): boolean => {
  const q = quietHours();
  if (!q) return false;
  const h = (new Date(now).getUTCHours() + 9) % 24;
  const [from, to] = q;
  return from < to ? h >= from && h < to : h >= from || h < to;
};

export type Launch = (bot: string, text: string, mission?: string) => void;

/**
 * Starts `dori delegate` as its own process, so a bot's long answer never holds up the duty loop. Its output goes to
 * autopilot/delegate.log; the parent closes its copy of the log right away. `cli`: the dori entry (tests pass a stub).
 */
export function startDelegate(d: Deps, bot: string, text: string, mission?: string, cli = CLI): ChildProcess {
  mkdirSync(autopilotDir(d.store.root), { recursive: true });
  const log = openSync(join(autopilotDir(d.store.root), "delegate.log"), "a");
  const argv = [cli, "delegate", bot, "--text", text, "--timeout", String(DELEGATE_TIMEOUT_S)];
  if (mission !== undefined) argv.push("--mission", mission);
  const env = { ...process.env, DORI_HOME: d.store.root };
  try {
    const child = spawn(process.execPath, argv, { detached: true, stdio: ["ignore", log, log], env });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

export const spawnDelegate =
  (d: Deps): Launch =>
  (bot, text, mission) => {
    startDelegate(d, bot, text, mission);
  };

const assignedKeys = (home: string): Set<string> => assignmentState(readAssignments(home)).held;

/** The bots agents.json names; none when it cannot be read (nothing is handed out then). */
function botNames(home: string): string[] | undefined {
  try {
    return loadAgents(home).map((a) => a.name);
  } catch {
    return undefined;
  }
}

/**
 * One task per idle bot: the first open task of the first project (by name) that names it or lists it as owner. An
 * idle bot with nothing to hand out is reported to the lead (`reports`) at most once per STALL_HOURS.
 */
function assignIdle(d: Deps, roadmaps: readonly Roadmap[], launch: Launch): { assigned: string[]; reports: string[] } {
  const home = d.store.root;
  const now = d.now();
  const names = botNames(home);
  if (names === undefined) return { assigned: ["agents.json을 읽을 수 없어 유휴 봇 배정을 건너뜀"], reports: [] };
  const reportedAt = { ...readState(home).idleReportedAt };
  const reports: string[] = [];
  const activity = botActivity(delegateRuns(home), now);
  const assigned = assignedKeys(home);
  const lastHanded = new Map<string, number>();
  for (const a of readAssignments(home))
    if (a.bot !== undefined && a.kind === "delegate") lastHanded.set(a.bot, Math.max(lastHanded.get(a.bot) ?? 0, a.at));
  const out: string[] = [];
  bots: for (const bot of names) {
    const act = activity.get(bot);
    if (act?.busy) continue;
    const since = Math.max(act?.lastAt ?? 0, lastHanded.get(bot) ?? 0);
    if (now - since < idleHours() * HOUR) continue;
    const idle = since === 0 ? "기록 없음" : `${Math.floor((now - since) / HOUR)}시간`;
    for (const r of roadmaps) {
      const t = r.tasks.find(
        (x) =>
          !x.done &&
          x.blocked === undefined &&
          x.kind === "delegate" &&
          !assigned.has(`${r.project}:${x.id}`) &&
          (x.bot === bot || (x.bot === undefined && r.owners.includes(bot))),
      );
      if (t === undefined) continue;
      const mission = `autopilot-${r.project}`;
      launch(bot, delegateText(r, t), KEY_RE.test(mission) ? mission : undefined);
      recordAssignment(home, {
        at: now,
        project: r.project,
        task: t.id,
        text: t.text,
        reason: "idle",
        kind: "delegate",
        bot,
      });
      assigned.add(`${r.project}:${t.id}`);
      out.push(`${bot} 유휴(${idle}) -> ${r.project}: ${t.text}`);
      delete reportedAt[bot];
      continue bots;
    }
    const report = noWorkReport(home, roadmaps, bot, idle, now, reportedAt);
    if (report !== undefined) reports.push(report);
  }
  writeJson(home, "state.json", { ...readState(home), idleReportedAt: reportedAt });
  return { assigned: out, reports };
}

async function checkStalls(d: Deps, roadmaps: readonly Roadmap[], launch: Launch): Promise<string[]> {
  const home = d.store.root;
  const now = d.now();
  const state = readState(home);
  const runs = delegateRuns(home);
  const out: string[] = [];
  const handed = readAssignments(home);
  // A bot still running a delegation, or handed one within its timeout (this pass's idle hand-outs included), is busy:
  // the stalled project waits for the next check rather than giving it a second delegation at once.
  const busy = new Set([...botActivity(runs, now)].filter(([, a]) => a.busy).map(([bot]) => bot));
  for (const [, a] of assignmentState(handed).latest)
    if (a.kind === "delegate" && a.bot !== undefined && now - a.at < DELEGATE_TIMEOUT_S * 1000) busy.add(a.bot);
  const acts = await Promise.all(roadmaps.map((r) => lastActivity(d, r, runs, handed)));
  for (const [i, r] of roadmaps.entries()) {
    const act = acts[i]!;
    state.activity[r.project] = act;
    const reported = state.stallReportedAt[r.project];
    if (now - act.at < STALL_HOURS * HOUR || (reported !== undefined && now - reported < STALL_HOURS * HOUR)) continue;
    const t = nextTask(r, assignedKeys(home));
    const bot = t?.kind === "delegate" ? taskBot(r, t) : undefined;
    if (bot !== undefined && busy.has(bot)) continue;
    const before = readAssignments(home).length;
    const made = t === undefined ? undefined : handOut(d, r, t, launch, new Set(botNames(home) ?? []));
    // Only a delegation actually recorded reserves its bot for the rest of this check, not a failure explanation.
    const fresh = readAssignments(home).slice(before);
    if (bot !== undefined && fresh.some((a) => a.kind === "delegate" && a.bot === bot)) busy.add(bot);
    state.stallReportedAt[r.project] = now;
    const hours = Math.floor((now - act.at) / HOUR);
    out.push(
      `[REPORT ${r.project} 정체] ${hours}시간째 활동 없음 (마지막: ${act.source} ${new Date(act.at).toISOString().slice(0, 16)}Z). ` +
        (made ? `자동 생성: ${made}` : `넘길 다음 할 일이 없음: ${r.file}에 추가해 주세요`),
    );
  }
  writeJson(home, "state.json", {
    ...readState(home),
    activity: state.activity,
    stallReportedAt: state.stallReportedAt,
  });
  return out;
}

/** Everything the board shows: roadmaps with each task's hand-out, each bot's idle time, and the newest hand-outs. */
export function autopilotStatus(d: Deps): Record<string, unknown> {
  const home = d.store.root;
  const now = d.now();
  const assignments = readAssignments(home);
  const state = readState(home);
  const handed = assignmentState(assignments).latest;
  const activity = botActivity(delegateRuns(home), now);
  return {
    at: new Date(now).toISOString(),
    stopped: autopilotStopped(home),
    idleHours: idleHours(),
    projects: loadRoadmaps(home).map((r) => ({
      ...r,
      tasks: r.tasks.map((t) => ({ ...t, assignment: handed.get(`${r.project}:${t.id}`) })),
      activity: state.activity[r.project],
      stallReportedAt: state.stallReportedAt[r.project],
    })),
    bots: [...activity].map(([name, a]) => ({
      name,
      busy: a.busy,
      lastAt: a.lastAt,
      idleMinutes: Math.floor((now - a.lastAt) / 60_000),
    })),
    assignments: assignments.slice(-100),
  };
}

/** One autopilot pass: idle bots every IDLE_CHECK_MS, stalls every STALL_CHECK_MS, both outside quiet hours. */
export async function autopilotTick(d: Deps, launch: Launch = spawnDelegate(d)): Promise<string[]> {
  const home = d.store.root;
  const roadmaps = loadRoadmaps(home);
  if (roadmaps.length === 0 || autopilotStopped(home) || quietHour(d.now())) return [];
  const now = d.now();
  const state = readState(home);
  const idleDue = now - (state.idleCheckAt ?? 0) >= IDLE_CHECK_MS;
  const stallDue = now - (state.stallCheckAt ?? 0) >= STALL_CHECK_MS;
  if (!idleDue && !stallDue) return [];
  writeJson(home, "state.json", {
    ...state,
    ...(idleDue ? { idleCheckAt: now } : {}),
    ...(stallDue ? { stallCheckAt: now } : {}),
  });
  const failed = idleDue ? checkOutcomes(d, roadmaps) : [];
  const { assigned, reports } = idleDue ? assignIdle(d, loadRoadmaps(home), launch) : { assigned: [], reports: [] };
  const stalls = stallDue ? await checkStalls(d, loadRoadmaps(home), launch) : [];
  const lines = [
    ...failed,
    ...(assigned.length ? [`[AUTOPILOT] 유휴 봇 배정: ${assigned.join("; ")}`] : []),
    ...reports,
    ...stalls,
  ];
  for (const line of lines) await tellLead(d, line, "duty");
  writeJson(home, "status.json", autopilotStatus(d));
  return lines;
}
