import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";
import { KEY_RE, type Lane } from "./store-types.ts";

/** DORI_HOME/budgets.json: a USD limit per lane key, and `default` for every lane without its own (#3). */
export type Budgets = { default?: number; lanes: Record<string, number> };

/** The share of a limit at which the lead is warned once; at the limit itself it is told OVER and nudges stop. */
const WARN_AT = 0.8;
/** How much of the bottom of a pane is read for omo's status line (`... • $6.856 • 120K/1M ...`). */
export const COST_SCREEN_LINES = 20;

const budgetsPath = (root: string): string => join(root, "budgets.json");

export function loadBudgets(root: string): Budgets {
  const path = budgetsPath(root);
  if (!existsSync(path)) return { lanes: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Budgets>;
  return { ...(raw.default !== undefined ? { default: raw.default } : {}), lanes: raw.lanes ?? {} };
}

export function setBudget(root: string, target: string, usd: number): Budgets {
  if (target !== "default" && !KEY_RE.test(target)) throw new Refusal(`budget target must be a lane key or default`);
  if (!Number.isFinite(usd) || usd <= 0) throw new Refusal("--usd must be a positive number of dollars");
  const b = loadBudgets(root);
  const next: Budgets = target === "default" ? { ...b, default: usd } : { ...b, lanes: { ...b.lanes, [target]: usd } };
  const path = budgetsPath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  return next;
}

export const limitFor = (b: Budgets, key: string): number | undefined => b.lanes[key] ?? b.default;

/**
 * The last `$<number>` that is a whole `•`-separated segment of a line: omo's session cost in its bottom status line
 * (`~/repo • CH93.0% • $0.743 • 80K/1M`). A `$` amount in the conversation above never counts, so a status line that
 * shows no cost (a subscription without one) reads as no cost, not as the last price someone mentioned.
 */
export function parseCost(screen: string): number | undefined {
  const last = [...screen.matchAll(/(?:^|•)[ \t]*\$(\d+(?:\.\d+)?)[ \t]*(?=•|$)/gm)].at(-1);
  return last === undefined ? undefined : Number(last[1]);
}

const RANK = { none: 0, "80": 1, over: 2 } as const;

/**
 * Records the cost read from `screen` on the lane and returns the lead's alert when the lane crossed into a higher
 * level (80% or OVER) than it was already told about; each level is sent once. A screen with no cost changes nothing.
 * A lane that falls back under a level (a raised limit, a new session) drops to it silently, so nudges resume.
 */
export function noteCost(
  lane: Lane,
  screen: string | undefined,
  limit: number | undefined,
  now: number,
): string | undefined {
  const cost = screen === undefined ? undefined : parseCost(screen);
  if (cost === undefined) return undefined;
  lane.costUsd = cost;
  lane.costAt = now;
  const level = limit === undefined ? "none" : cost >= limit ? "over" : cost >= limit * WARN_AT ? "80" : "none";
  const told = lane.budgetAlert ?? "none";
  if (level === "none") delete lane.budgetAlert;
  else lane.budgetAlert = level;
  if (RANK[level] <= RANK[told]) return undefined;
  const text =
    level === "over"
      ? `[BUDGET OVER] ${lane.key} $${cost} / $${limit}: nudges stopped; the lane keeps running`
      : `[BUDGET 80%] ${lane.key} $${cost} / $${limit}`;
  lane.log.push({ at: now, kind: "budget", text });
  return text;
}

/** `$6.856 / $50 (14%)`, `$6.856` without a limit, `- / $50` before a first reading, `-` with neither. */
export function costText(lane: Lane, limit: number | undefined): string {
  const cost = lane.costUsd === undefined ? "-" : `$${lane.costUsd}`;
  if (limit === undefined) return cost;
  const pct = lane.costUsd === undefined ? "" : ` (${Math.round((lane.costUsd / limit) * 100)}%)`;
  return `${cost} / $${limit}${pct}`;
}
