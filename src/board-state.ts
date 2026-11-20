import type { Ask } from "./asks.ts";
import { type AgentActivity, agentActivity } from "./board-agents.ts";
import { type BotCard, botCards, firstLine } from "./board-bots.ts";
import { type ChatMessage, chatTail } from "./board-chat.ts";
import { agentsOrNone, avatarUrls } from "./board-avatars.ts";
import { type Hub, readHub } from "./board-hub.ts";
import { openAsks } from "./board-asks.ts";
import { type HubEvent, itemEvents, laneEvents, lanePurpose } from "./board-hub-state.ts";
import { missionState } from "./board-missions.ts";
import { routines } from "./board-mission-sources.ts";
import type { Mission, MissionCard, Routine } from "./board-mission-types.ts";
import { type Link, OTHER, projectAliases, projectResolver, projectSeeds, type Subject } from "./board-projects.ts";
import { lanePrs, type Pr } from "./board-prs.ts";
import type { Milestone } from "./board-tasks.ts";
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
  item?: true; // a done backlog item listed with the day's finished lanes, not a lane
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
  prefixes: string[]; // the lead's key prefixes: a Discord channel named by one (`fmv`) belongs to the project
  /** board.json's one-line description and links for the project. */
  note: string | null;
  links: Link[];
  milestones: Milestone[];
  /** The note, else the title of its newest lane's brief. */
  purpose: string | null;
  /** The open asks about it (by the ask id's key prefix, else the project its question names). */
  asks: Ask[];
  /** Lane starts, READYs, finishes and backlog additions of the last week, unsorted. */
  events: HubEvent[];
};

export type BoardState = {
  generatedAt: number;
  /** The open asks jaeil answers, and every open ask for the 확인 필요 tab (see openAsks). */
  asks: Ask[];
  checks: Ask[];
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
  /** PR states and project numbers the board process collected (board-hub.json); null before the first collection. */
  hub: Hub | null;
  /** The 에이전트 tab: what the lead, each open lane, each bot and Muse is doing. */
  agents: AgentActivity[];
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
  const subjects: Subject[] = [
    ...lanes.map(laneSubject),
    ...items.map((i) => ({ key: i.id, cwd: i.cwd, repos: [], title: i.title })),
  ];
  const projectOf = projectResolver(seeds, projectAliases(store.root), subjects);
  const places = new Set([...seeds.map((p) => p.name), ...subjects.map(projectOf)]);
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
      milestones: mine.flatMap((p) => p.milestones),
      purpose: null,
      asks: [],
      events: [],
    };
    groups.set(name, g);
    return g;
  };
  /** The project a repo itself belongs to (yogaday.love → yogaday), by the same rules as work. */
  const repoHome = new Map<string, string>();
  const homeOf = (repo: string): string => {
    const r = repo.toLowerCase();
    if (!repoHome.has(r)) repoHome.set(r, projectOf({ key: "", cwd: "", repos: [r] }));
    return repoHome.get(r)!;
  };
  /** A repo of another project that is on the board (a seed or where some work sits): not this project's repo. */
  const foreign = (repo: string, name: string): boolean => {
    const h = homeOf(repo);
    return h !== name && h !== OTHER && places.has(h);
  };
  const shownLanes = lanes.filter((l) => l.status !== "done" || now - l.lastActivityAt < WEEK_MS);
  const nameOf = new Map(shownLanes.map((l) => [l.key, projectOf(laneSubject(l))]));
  const prId = (p: Pr): string => `${p.repo?.toLowerCase()}#${p.num}`;
  /** The PRs each project's shown lanes name. */
  const cited = new Map<string, Set<string>>();
  for (const l of shownLanes)
    for (const p of lanePrs(l)) {
      const n = nameOf.get(l.key)!;
      cited.set(n, (cited.get(n) ?? new Set()).add(prId(p)));
    }
  /** A PR in another project's repo that a lane of that project also names shows there only (yogaday.love#87). */
  const elsewhere = (p: Pr, name: string): boolean =>
    p.repo !== null && foreign(p.repo, name) && (cited.get(homeOf(p.repo))?.has(prId(p)) ?? false);
  const attention: ProjectLane[] = [];
  for (const l of lanes) {
    const name = nameOf.get(l.key) ?? projectOf(laneSubject(l));
    const entry = l.log.at(-1);
    const latest = entry?.kind === "start" || entry?.kind === "adopt" ? "시작함" : entry?.text;
    const last = l.status === "ready" || l.status === "done" ? (l.final?.text ?? latest) : latest;
    const pl: ProjectLane = {
      key: l.key,
      status: l.status,
      at: l.lastActivityAt,
      first: firstLine(last ?? ""),
      full: last ?? "",
      prs: lanePrs(l).filter((p) => !elsewhere(p, name)),
      escalated: l.status === "working" && l.nudges >= NUDGE_MINUTES.length,
    };
    if (l.status === "done" && now - l.lastActivityAt >= WEEK_MS) continue;
    const g = group(name);
    g.at = Math.max(g.at, l.lastActivityAt);
    g.events.push(...laneEvents(l, now));
    for (const p of pl.prs) {
      const r = p.repo?.toLowerCase();
      if (r && !foreign(r, name) && !g.repos.includes(r)) g.repos.push(r);
    }
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
    const g = group(projectOf({ key: i.id, cwd: i.cwd, repos: [], title: i.title }));
    g.at = Math.max(g.at, i.updatedAt);
    g.events.push(...itemEvents(i, now));
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
    const newest = g.lanes[0] ?? g.recent[0];
    const lane = newest ? lanes.find((l) => l.key === newest.key) : undefined;
    g.purpose = g.note ?? (lane ? lanePurpose(lane.brief, lane.key) : null);
  }
  const { asks: open, checks } = openAsks(store.root, groups, sorted, projectOf);
  const standing = standingCards(store, now);
  const agents = agentsOrNone(store.root);
  const bots = botCards(store.root, now, agents);
  const avatars = avatarUrls(store.root, agents);
  const chat = chatTail(store.root, CHAT_SHOWN);
  return {
    ...missionState(store, bots, standing.cards, now, agents, avatars),
    routines: routines(store.root),
    avatars,
    generatedAt: now,
    standing: standing.cards,
    standingError: standing.error,
    chat,
    agents: agentActivity(store, now, bots, chat),
    asks: open,
    checks,
    hub: readHub(store.root),
    attention: attention.sort((a, b) => b.at - a.at),
    bots,
    projects: sorted,
  };
}
