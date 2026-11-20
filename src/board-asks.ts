import { type Ask, ASK_FOR, type AskFor, askFor, asks } from "./asks.ts";
import { askText } from "./board-hub-state.ts";
import { messageProject, OTHER, type Subject } from "./board-projects.ts";
import type { ProjectGroup } from "./board-state.ts";

export const PERSON: Record<AskFor, string> = { jaeil: "재일 님", bokyung: "보경 님" };

/**
 * The open asks: `checks` every one, oldest first, for the 확인 필요 tab; `asks` the ones jaeil answers, the only ones
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

/** The open asks by who answers them, in ASK_FOR order; a person with none keeps an empty group. */
export const byPerson = (checks: Ask[]): { who: AskFor; label: string; asks: Ask[] }[] =>
  ASK_FOR.map((who) => ({ who, label: PERSON[who], asks: checks.filter((a) => askFor(a) === who) }));
