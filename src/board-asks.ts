import { type Ask, ASK_FOR, type AskFor, askFor, asks } from "./asks.ts";
import { askText } from "./board-hub-state.ts";
import { messageProject, OTHER, type Subject } from "./board-projects.ts";
import type { ProjectGroup } from "./board-state.ts";

export const PERSON: Record<AskFor, string> = { jaeil: "재일 님", bokyung: "보경 님" };

/**
 * The open asks: `checks` every one for the 확인 필요 tab (byPerson orders them); `asks` the ones jaeil answers, the only ones
 * the 작업 tab's 재일 님 차례, the lead's record and the project badges count. Each of jaeil's goes to the project it is
 * about (by the ask id's key prefix, else the project its question names).
 */
export function openAsks(
  home: string,
  groups: Map<string, ProjectGroup>,
  sorted: ProjectGroup[],
  projectOf: (s: Subject) => string,
): { asks: Ask[]; checks: Ask[] } {
  const checks = asks(home).filter((a) => a.status === "open");
  const mine = checks.filter((a) => askFor(a) === "jaeil");
  for (const a of mine) {
    const byKey = groups.get(projectOf({ key: a.id, cwd: "", repos: [] }));
    const g = byKey && byKey.name !== OTHER ? byKey : groups.get(messageProject(askText(a), sorted) ?? "");
    g?.asks.push(a);
  }
  return { asks: mine, checks };
}

const KST = 9 * 3_600_000;

/**
 * When an ask was made, in ms: `createdAt` as written, a number (below 1e12 read as seconds) or a string of digits or
 * an ISO time; undefined when it is none of these, so a hand-written file cannot break the tab.
 */
export function askTime(a: { createdAt?: unknown }): number | undefined {
  const v = a.createdAt;
  const n = typeof v === "number" ? v : typeof v === "string" ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN;
  const t = n > 0 && n < 1e12 ? n * 1000 : n;
  return Number.isFinite(t) ? t : undefined;
}

/** The KST clock of `t` as 'MM/DD HH:mm'. */
export const kstStamp = (t: number): string =>
  new Date(t + KST).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

/** Newest first; an ask with no readable time goes last, ties by id. */
const newestFirst = (a: Ask, b: Ask): number =>
  (askTime(b) ?? -Infinity) - (askTime(a) ?? -Infinity) || a.id.localeCompare(b.id);

/** The open asks by who answers them, in ASK_FOR order, newest first; a person with none keeps an empty group. */
export const byPerson = (checks: Ask[]): { who: AskFor; label: string; asks: Ask[] }[] =>
  ASK_FOR.map((who) => ({
    who,
    label: PERSON[who],
    asks: checks.filter((a) => askFor(a) === who).sort(newestFirst),
  }));
