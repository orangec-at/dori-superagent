// The autopilot's files under `$DORI_HOME/autopilot/`, and what it reads from the delegation logs. The board reads
// status.json and assignments.jsonl as they are (docs/autopilot.md).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One line of assignments.jsonl. `delegate` / `backlog`: roadmap work handed to a bot or to the backlog (a lane, then
 * a PR). `release`: that delegation failed (`outcome`), so the task may be handed out again; with `final` it failed
 * too often and stays held until a person edits the roadmap.
 */
export type Assignment = {
  readonly at: number;
  readonly project: string;
  readonly task: string;
  readonly text: string;
  readonly reason: "idle" | "stall";
  readonly kind: "delegate" | "backlog" | "release";
  readonly bot?: string;
  readonly item?: string;
  readonly outcome?: string;
  readonly final?: boolean;
};

export const assignmentKey = (a: { project: string; task: string }): string => `${a.project}:${a.task}`;

/** Each task's newest line, and how many times it was released. A task is held unless its newest line is a release. */
export function assignmentState(list: readonly Assignment[]): {
  latest: Map<string, Assignment>;
  releases: Map<string, number>;
  held: Set<string>;
} {
  const latest = new Map<string, Assignment>();
  const releases = new Map<string, number>();
  for (const a of list) {
    latest.set(assignmentKey(a), a);
    if (a.kind === "release") releases.set(assignmentKey(a), (releases.get(assignmentKey(a)) ?? 0) + 1);
  }
  const held = new Set([...latest].filter(([, a]) => a.kind !== "release" || a.final).map(([k]) => k));
  return { latest, releases, held };
}

export type ProjectActivity = { readonly at: number; readonly source: string };

export type AutopilotState = {
  idleCheckAt?: number;
  stallCheckAt?: number;
  /** When each project's stall was last reported, so one stall is told once a day, not every hour. */
  stallReportedAt: Record<string, number>;
  /** When each idle bot with nothing to hand out was last reported, so it is told once a day, not every pass. */
  idleReportedAt?: Record<string, number>;
  /** Each project's newest activity as the last stall check found it. */
  activity: Record<string, ProjectActivity>;
};

export const autopilotDir = (home: string): string => join(home, "autopilot");
const file = (home: string, name: string): string => join(autopilotDir(home), name);

/** A stop file turns every autopilot assignment and stall report off; autostart of backlog items is unaffected. */
export const autopilotStopped = (home: string): boolean => existsSync(file(home, "stop"));

const jsonLines = (path: string): Record<string, unknown>[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const v = JSON.parse(line) as unknown;
        return v !== null && typeof v === "object" ? [v as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
};

export const readAssignments = (home: string): Assignment[] =>
  jsonLines(file(home, "assignments.jsonl")) as unknown as Assignment[];

export function recordAssignment(home: string, a: Assignment): void {
  mkdirSync(autopilotDir(home), { recursive: true });
  appendFileSync(file(home, "assignments.jsonl"), `${JSON.stringify(a)}\n`);
}

export function readState(home: string): AutopilotState {
  try {
    const v = JSON.parse(readFileSync(file(home, "state.json"), "utf8")) as Partial<AutopilotState>;
    return { ...v, stallReportedAt: v.stallReportedAt ?? {}, activity: v.activity ?? {} };
  } catch {
    return { stallReportedAt: {}, activity: {} };
  }
}

export function writeJson(home: string, name: "state.json" | "status.json", value: unknown): void {
  mkdirSync(autopilotDir(home), { recursive: true });
  writeFileSync(file(home, name), `${JSON.stringify(value, null, 2)}\n`);
}

export function writeBrief(home: string, id: string, text: string): string {
  mkdirSync(join(autopilotDir(home), "briefs"), { recursive: true });
  const path = join(autopilotDir(home), "briefs", `${id}.md`);
  writeFileSync(path, text);
  return path;
}

/** A delegation start from delegate-runs.jsonl, joined with its end from delegations.jsonl when there is one. */
export type DelegateRun = {
  readonly agent: string;
  readonly text: string;
  readonly at: number;
  readonly until: number;
  /** When the run ended: its `endedAt`, or its start for lines written before endedAt existed. */
  readonly endedAt?: number;
};

/** A finished delegation from delegations.jsonl: who, the first 200 characters of its text, and how it ended. */
export type DelegateEnd = {
  readonly agent: string;
  readonly text: string;
  readonly at: number;
  readonly outcome: string;
};

export const delegateEnds = (home: string): DelegateEnd[] =>
  jsonLines(join(home, "delegations.jsonl")).flatMap((e) =>
    typeof e["agent"] === "string" && typeof e["text"] === "string" && !Number.isNaN(ms(e["at"]))
      ? [{ agent: e["agent"], text: e["text"], at: ms(e["at"]), outcome: String(e["outcome"]) }]
      : [],
  );

const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);

export function delegateRuns(home: string): DelegateRun[] {
  const ends = new Map<string, number>();
  for (const e of jsonLines(join(home, "delegations.jsonl"))) {
    const end = ms(e["endedAt"]);
    ends.set(`${String(e["at"])}|${String(e["agent"])}`, Number.isNaN(end) ? ms(e["at"]) : end);
  }
  return jsonLines(join(home, "delegate-runs.jsonl")).flatMap((r) => {
    const at = ms(r["at"]);
    if (typeof r["agent"] !== "string" || Number.isNaN(at)) return [];
    const until = ms(r["until"]);
    const endedAt = ends.get(`${String(r["at"])}|${r["agent"]}`);
    return [
      {
        agent: r["agent"],
        text: typeof r["text"] === "string" ? r["text"] : "",
        at,
        until: Number.isNaN(until) ? at : until,
        ...(endedAt !== undefined ? { endedAt } : {}),
      },
    ];
  });
}

/**
 * Each bot's state now: busy while a run has neither ended nor run past its timeout; otherwise idle since its newest
 * end (an unended run that timed out ends at its timeout).
 */
export function botActivity(runs: readonly DelegateRun[], now: number): Map<string, { busy: boolean; lastAt: number }> {
  const out = new Map<string, { busy: boolean; lastAt: number }>();
  for (const r of runs) {
    const busy = r.endedAt === undefined && r.until > now;
    const end = r.endedAt ?? Math.min(r.until, now);
    const prev = out.get(r.agent) ?? { busy: false, lastAt: 0 };
    out.set(r.agent, { busy: prev.busy || busy, lastAt: Math.max(prev.lastAt, end) });
  }
  return out;
}
