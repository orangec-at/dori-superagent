import { type Ask, asks } from "./asks.ts";
import { type BotCard, botCards, firstLine } from "./board-bots.ts";
import { type ChatMessage, chatTail } from "./board-chat.ts";
import { agentsOrNone, avatarUrls } from "./board-avatars.ts";
import { missionState } from "./board-missions.ts";
import { routines } from "./board-mission-sources.ts";
import type { Mission, MissionCard, Routine } from "./board-mission-types.ts";
import { type Link, OTHER, projectResolver, projectSeeds, type Subject } from "./board-projects.ts";
import { lanePrs, type Pr } from "./board-prs.ts";
import { type StandingCard, standingCards } from "./board-status.ts";
import { NUDGE_MINUTES } from "./duty.ts";
import type { Store } from "./store.ts";
import type { ItemStatus, LaneStatus } from "./store-types.ts";

/** `prs`: the pull requests the lane names; `escalated`: duty used every nudge on it and told the lead (ESCALATE). */
export type ProjectLane = {
  key: string;
  status: LaneStatus;
  at: number;
  first: string;
  full: string;
  prs: Pr[];
  escalated: boolean;
  /** A done backlog item listed with the day's finished lanes, not a lane. */
  item?: true;
};
/**
 * `done`: lanes and items finished in the last day (listed as fresh results); `recent`: lanes finished in the last week
 * (the project view); `at`: the newest activity; `repos`/`bots`: the lead's and the PRs' repos, the lead's bots.
 */
export type ProjectGroup = {
  name: string;
  lanes: ProjectLane[];
  backlog: { id: string; title: string; priority: number; status: ItemStatus; decision: string | null }[];
  done: ProjectLane[];
  recent: ProjectLane[];
  at: number;
  repos: string[];
  bots: string[];
  /** The lead's key prefixes: a Discord channel named by one (`fmv`) belongs to the project. */
  prefixes: string[];
  /** board.json's one-line description and links for the project. */
  note: string | null;
  links: Link[];
};

export type BoardState = {
  generatedAt: number;
  asks: Ask[];
  /** Lanes the operator should look at: ready (a PR to check), waiting, lost. */
  attention: ProjectLane[];
  bots: BotCard[];
  projects: ProjectGroup[];
  standing: StandingCard[];
  /** Why leads.json could not be read. */
  standingError: string | null;
  /** The newest messages between the operator and the lead, oldest first. */
  chat: ChatMessage[];
  /** Work several bots took part in, newest first, and the mission card of each bot, standing lead and lane row. */
  missions: Mission[];
  cards: Record<string, MissionCard>;
  routines: Routine[];
  /** Row id -> its picture URL (/avatar/<name>); a row without one keeps its letter circle. */
  avatars: Record<string, string>;
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const CHAT_SHOWN = 60;

export function boardState(store: Store, now: number): BoardState {
  const seeds = projectSeeds(store.root);
  const lanes = store.lanes();
  const items = store.items();
  const laneSubject = (l: (typeof lanes)[number]): Subject => ({
    key: l.key,
    cwd: l.cwd,
    repos: lanePrs(l).flatMap((p) => (p.repo ? [p.repo] : [])),
  });
  const projectOf = projectResolver(seeds, [
    ...lanes.map(laneSubject),
    ...items.map((i) => ({ key: i.id, cwd: i.cwd, repos: [] })),
  ]);
  const groups = new Map<string, ProjectGroup>();
  const group = (name: string): ProjectGroup => {
    const found = groups.get(name);
    if (found) return found;
    const mine = seeds.filter((p) => p.name === name);
    const all = (f: (p: (typeof seeds)[number]) => string[]): string[] => [...new Set(mine.flatMap(f))];
    const g: ProjectGroup = {
      name,
      lanes: [],
      backlog: [],
      done: [],
      recent: [],
      at: 0,
      repos: all((p) => p.repos),
      bots: all((p) => p.bots),
      prefixes: all((p) => p.prefixes),
      note: mine.find((p) => p.note)?.note ?? null,
      links: mine.flatMap((p) => p.links),
    };
    groups.set(name, g);
    return g;
  };
  const attention: ProjectLane[] = [];
  for (const l of lanes) {
    const entry = l.log.at(-1);
    const latest = entry?.kind === "start" || entry?.kind === "adopt" ? "시작함" : entry?.text;
    const last = l.status === "ready" || l.status === "done" ? (l.final?.text ?? latest) : latest;
    const pl: ProjectLane = {
      key: l.key,
      status: l.status,
      at: l.lastActivityAt,
      first: firstLine(last ?? ""),
      full: last ?? "",
      prs: lanePrs(l),
      escalated: l.status === "working" && l.nudges >= NUDGE_MINUTES.length,
    };
    if (l.status === "done" && now - l.lastActivityAt >= WEEK_MS) continue;
    const g = group(projectOf(laneSubject(l)));
    g.at = Math.max(g.at, l.lastActivityAt);
    for (const p of pl.prs) if (p.repo && !g.repos.includes(p.repo.toLowerCase())) g.repos.push(p.repo.toLowerCase());
    if (l.status === "done") {
      g.recent.push(pl);
      if (now - l.lastActivityAt < DAY_MS) g.done.push(pl);
      continue;
    }
    g.lanes.push(pl);
    if (l.status !== "working") attention.push(pl);
  }
  for (const i of items) {
    if (i.status === "dropped" || (i.status === "done" && now - i.updatedAt >= DAY_MS)) continue;
    const g = group(projectOf({ key: i.id, cwd: i.cwd, repos: [] }));
    g.at = Math.max(g.at, i.updatedAt);
    if (i.status === "done") {
      const title = firstLine(i.title);
      g.done.push({
        key: i.id,
        status: "done",
        at: i.updatedAt,
        first: title,
        full: i.title,
        prs: [],
        escalated: false,
        item: true,
      });
      continue;
    }
    g.backlog.push({ id: i.id, title: i.title, priority: i.priority, status: i.status, decision: i.decision ?? null });
  }
  // A seeded project shows with no work too; with no activity (at 0) it sorts after the active ones.
  for (const p of seeds) group(p.name);
  const sorted = [...groups.values()].sort(
    (a, b) => Number(a.name === OTHER) - Number(b.name === OTHER) || b.at - a.at,
  );
  for (const g of sorted) {
    g.lanes.sort((a, b) => b.at - a.at);
    g.done.sort((a, b) => b.at - a.at);
    g.recent.sort((a, b) => b.at - a.at);
    g.backlog.sort((a, b) => a.priority - b.priority);
  }
  const standing = standingCards(store, now);
  const agents = agentsOrNone(store.root);
  const bots = botCards(store.root, now, agents);
  const avatars = avatarUrls(store.root, agents);
  return {
    ...missionState(store, bots, standing.cards, now, agents, avatars),
    routines: routines(store.root),
    avatars,
    generatedAt: now,
    standing: standing.cards,
    standingError: standing.error,
    chat: chatTail(store.root, CHAT_SHOWN),
    asks: asks(store.root).filter((a) => a.status === "open"),
    attention: attention.sort((a, b) => b.at - a.at),
    bots,
    projects: sorted,
  };
}
