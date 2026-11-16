import type { BotCard } from "./board-bots.ts";
import type { ProjectGroup, ProjectLane } from "./board-state.ts";

/**
 * The project page's work as one list of tasks in four columns: backlog items (할 일), lanes at work and running items
 * (진행 중), lanes READY with their PR (검토), and lanes and items finished this week (완료); a project bot's last
 * delegation of the week is a task too. A backlog item that already runs as a lane is that lane, with its priority.
 */
export type Column = "todo" | "doing" | "review" | "done";
export const COLUMNS: readonly [Column, string][] = [
  ["todo", "할 일"],
  ["doing", "진행 중"],
  ["review", "검토"],
  ["done", "완료"],
];
export type Task = {
  id: string;
  kind: "item" | "lane" | "bot";
  title: string;
  col: Column;
  priority: number | null;
  /** A lane lost or escalated, or a delegation that did not finish. */
  blocked: boolean;
  /** The question a backlog item waits on. */
  decision: string | null;
  /** It waits on the operator: a decision, a READY lane or a lane waiting for an answer. */
  mine: boolean;
  prs: number[];
  at: number;
  /** Where its record opens on the board, or null. */
  href: string | null;
  /** An open backlog item: the board may change its priority, answer its decision or drop it. */
  editable: boolean;
};
export type TaskFilter = "all" | "mine" | "blocked" | "item" | "lane";
export const FILTERS: readonly [TaskFilter, string][] = [
  ["all", "전체"],
  ["mine", "내 차례"],
  ["blocked", "막힘"],
  ["item", "백로그"],
  ["lane", "lane"],
];
/** board.json projects[].milestones: a name, an optional due date (YYYY-MM-DD) and the item or lane keys it needs. */
export type Milestone = { name: string; due: string | null; items: string[] };

const WEEK_MS = 7 * 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The `milestones` field of a board.json project: [] when absent, null when any entry has the wrong shape. */
export function milestonesOf(v: unknown): Milestone[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: Milestone[] = [];
  for (const m of v) {
    if (typeof m !== "object" || m === null) return null;
    const o = m as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"].trim() : "";
    const due = o["due"] === undefined ? null : typeof o["due"] === "string" && DAY_RE.test(o["due"]) ? o["due"] : 0;
    const items = o["items"] === undefined ? [] : o["items"];
    if (!name || due === 0 || !Array.isArray(items) || !items.every((i) => typeof i === "string")) return null;
    out.push({ name, due, items: items as string[] });
  }
  return out;
}

const laneHref = (key: string): string => `/?c=${encodeURIComponent(`lane:${key}`)}`;

function laneTask(l: ProjectLane, priority: number | null): Task {
  const col: Column = l.status === "done" ? "done" : l.status === "ready" ? "review" : "doing";
  return {
    id: l.key,
    kind: l.item ? "item" : "lane",
    title: l.item ? l.full : `${l.key} — ${l.first}`,
    col,
    priority,
    blocked: l.status === "lost" || l.escalated,
    decision: null,
    mine: l.status === "ready" || l.status === "waiting",
    prs: l.prs.map((p) => p.num),
    at: l.at,
    href: l.item ? null : laneHref(l.key),
    editable: false,
  };
}

export function projectTasks(
  g: Pick<ProjectGroup, "lanes" | "backlog" | "recent" | "done" | "bots">,
  bots: BotCard[],
  now: number,
): Task[] {
  const prio = new Map(g.backlog.map((i) => [i.id, i.priority]));
  const laneKeys = new Set([...g.lanes, ...g.recent].map((l) => l.key));
  const tasks: Task[] = [
    ...g.lanes.map((l) => laneTask(l, prio.get(l.key) ?? null)),
    ...g.recent.map((l) => laneTask(l, null)),
    ...g.done.filter((l) => l.item && !laneKeys.has(l.key)).map((l) => laneTask(l, null)),
  ];
  for (const i of g.backlog) {
    if (laneKeys.has(i.id)) continue;
    tasks.push({
      id: i.id,
      kind: "item",
      title: i.title,
      col: i.status === "running" ? "doing" : "todo",
      priority: i.priority,
      blocked: false,
      decision: i.decision,
      mine: i.decision !== null,
      prs: [],
      at: 0,
      href: null,
      editable: i.status === "open",
    });
  }
  for (const b of bots) {
    const d = b.lastDelegate;
    const at = d ? Date.parse(d.at) : Number.NaN;
    if (!d || !g.bots.includes(b.name) || !(now - at < WEEK_MS)) continue;
    const ok = d.outcome === "ok";
    tasks.push({
      id: `bot:${b.name}`,
      kind: "bot",
      title: `${b.label} 위임 — ${d.summary || d.outcome}`,
      col: ok ? "done" : "doing",
      priority: null,
      blocked: !ok,
      decision: null,
      mine: false,
      prs: [],
      at,
      href: `/?c=${encodeURIComponent(`bot:${b.name}`)}`,
      editable: false,
    });
  }
  // The operator's and the stuck first, then by priority (1 first), then the newest.
  return tasks.sort(
    (a, b) =>
      Number(b.mine || b.blocked) - Number(a.mine || a.blocked) ||
      (a.priority ?? 10) - (b.priority ?? 10) ||
      b.at - a.at,
  );
}

export function filterTasks(tasks: Task[], f: TaskFilter): Task[] {
  if (f === "mine") return tasks.filter((t) => t.mine);
  if (f === "blocked") return tasks.filter((t) => t.blocked);
  if (f === "item") return tasks.filter((t) => t.kind === "item");
  if (f === "lane") return tasks.filter((t) => t.kind === "lane");
  return tasks;
}

/** Done of a milestone's keys: a key is done when its task is in 완료; a key the board no longer shows counts as done. */
export function progressOf(m: Milestone, tasks: Task[]): { done: number; total: number } {
  const col = new Map(tasks.map((t) => [t.id, t.col]));
  const done = m.items.filter((k) => (col.get(k) ?? "done") === "done").length;
  return { done, total: m.items.length };
}

/** The unfinished milestone with the nearest due date (overdue ones included), or null. */
export function nextDue(ms: Milestone[], tasks: Task[]): Milestone | null {
  return (
    ms
      .filter((m) => m.due !== null && progressOf(m, tasks).done < m.items.length)
      .sort((a, b) => a.due!.localeCompare(b.due!))[0] ?? null
  );
}

/** Days from today (KST) to a YYYY-MM-DD date: 0 today, negative when past. */
export function daysUntil(due: string, now: number): number {
  const today = Date.parse(new Date(now + 9 * 3_600_000).toISOString().slice(0, 10));
  return Math.round((Date.parse(due) - today) / 86_400_000);
}
