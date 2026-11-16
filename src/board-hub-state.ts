import { readFileSync, statSync } from "node:fs";
import type { Ask } from "./asks.ts";
import { firstLine } from "./board-bots.ts";
import { type Hub, type HubPr, prKey } from "./board-hub.ts";
import type { Pr } from "./board-prs.ts";
import type { ProjectGroup, ProjectLane } from "./board-state.ts";
import type { Item, Lane } from "./store-types.ts";

/** What the project page's status card says: one badge, its 1-3 next steps and what waits on the operator. */
export type Badge = "blocked" | "turn" | "active" | "rest";
export const BADGE_WORD: Record<Badge, string> = {
  blocked: "막힘",
  turn: "재일 님 차례",
  active: "진행 중",
  rest: "쉬는 중",
};
export type Decision = { title: string; sub: string; href: string };
export type HubEventKind = "start" | "ready" | "done" | "lost" | "backlog" | "merged" | "talk";
/** `href`: where the row leads (a talk row opens its Discord channel). */
export type HubEvent = { at: number; kind: HubEventKind; text: string; href?: string };

const WEEK_MS = 7 * 86_400_000;
const NEXT_LANES = 2;
const LANE_KINDS: Partial<Record<Lane["log"][number]["kind"], HubEventKind>> = {
  start: "start",
  adopt: "start",
  ready: "ready",
  done: "done",
  lost: "lost",
};

/**
 * Blocked: a lane lost or escalated. The operator's turn: an open ask, a backlog item waiting on a decision, a lane
 * ready or waiting. Active: a lane at work or a backlog item running. Else resting.
 */
export function badgeOf(g: Pick<ProjectGroup, "lanes" | "backlog" | "asks">): Badge {
  if (g.lanes.some((l) => l.status === "lost" || l.escalated)) return "blocked";
  if (
    g.asks.some((a) => !a.sent) ||
    g.backlog.some((i) => i.decision && i.status === "open") ||
    g.lanes.some((l) => l.status === "ready" || l.status === "waiting")
  )
    return "turn";
  return g.lanes.length || g.backlog.some((i) => i.status === "running") ? "active" : "rest";
}

/** The latest report of up to two lanes at work, then the highest-priority open backlog item that needs no decision. */
export function nextSteps(g: Pick<ProjectGroup, "lanes" | "backlog">): string[] {
  const lanes = g.lanes.filter((l) => l.status === "working").map((l) => `${l.key} — ${l.first}`);
  const item = g.backlog.find((i) => i.status === "open" && !i.decision);
  return [...lanes.slice(0, NEXT_LANES), ...(item ? [`다음: ${firstLine(item.title)}`] : [])];
}

/** The open asks, backlog decisions and lanes that wait on the operator, in that order. */
export function decisions(g: Pick<ProjectGroup, "lanes" | "backlog" | "asks">): Decision[] {
  const lane = (key: string): string => `/?c=${encodeURIComponent(`lane:${key}`)}`;
  return [
    ...g.asks
      .filter((a) => !a.sent)
      .map((a) => ({
        title: a.question,
        sub: a.recommend ? `추천 ${a.recommend}` : "결정",
        href: `/?c=${encodeURIComponent(`ask:${a.id}`)}`,
      })),
    ...g.backlog
      .filter((i) => i.decision && i.status === "open")
      .map((i) => ({ title: firstLine(i.title), sub: `결정 필요: ${i.decision}`, href: "/?tab=backlog" })),
    ...g.lanes
      .filter((l) => l.status === "ready" || l.status === "waiting")
      .map((l) => ({
        title: l.key,
        sub: l.status === "waiting" ? "답 기다림" : l.prs.length ? "머지 승인" : "확인",
        href: lane(l.key),
      })),
  ];
}

/** A lane's start, READY, done and lost in the last week. */
export const laneEvents = (l: Pick<Lane, "key" | "log">, now: number): HubEvent[] =>
  l.log.flatMap((e) => {
    const kind = LANE_KINDS[e.kind];
    if (!kind || now - e.at > WEEK_MS) return [];
    const say = kind === "ready" || kind === "lost" ? firstLine(e.text) : "";
    return [{ at: e.at, kind, text: say ? `${l.key} — ${say}` : l.key }];
  });

/** A backlog item added in the last week. */
export const itemEvents = (i: Pick<Item, "title" | "log">, now: number): HubEvent[] =>
  i.log
    .filter((e) => e.kind === "add" && now - e.at <= WEEK_MS)
    .map((e) => ({ at: e.at, kind: "backlog", text: firstLine(i.title) }));

const titles = new Map<string, { mtimeMs: number; head: string | null }>();
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The brief's `# ` title without the `Lane <key>:` it starts with: the project's purpose when board.json has no note.
 * The heading is read again only when the file's mtime changes, so a poll costs one stat per project.
 */
export function briefTitle(path: string, key: string): string | null {
  let head: string | null;
  try {
    const { mtimeMs } = statSync(path);
    const known = titles.get(path);
    head =
      known?.mtimeMs === mtimeMs
        ? known.head
        : (readFileSync(path, "utf8")
            .split("\n")
            .find((l) => l.startsWith("# "))
            ?.slice(2) ?? null);
    titles.set(path, { mtimeMs, head });
  } catch {
    return null;
  }
  const t = head?.replace(new RegExp(`^(?:lane\\s+)?${reEscape(key)}\\s*[:—-]\\s*`, "i"), "").trim();
  return t || null;
}

/**
 * The brief title as a project's purpose; one that only names a PR (`PR #32 후속`, `#31 리뷰`) says nothing of the work, so the
 * lane key leads it.
 */
export function lanePurpose(path: string, key: string): string | null {
  const t = briefTitle(path, key);
  return t && /^(?:PR\s*)?#\d+/i.test(t) ? `${key} — ${t}` : t;
}

export type PrState = HubPr["state"] | null;
export type PrEntry = { p: Pr; l: ProjectLane; state: PrState; at: number | null };

/** Each PR once with its state; shown: open, merged this week, or not yet read while its lane is open. */
export function prGroups(g: Pick<ProjectGroup, "lanes" | "recent">, hub: Hub | null, now: number) {
  const seen = new Set<string>();
  const all: PrEntry[] = [];
  for (const l of [...g.lanes, ...g.recent])
    for (const p of l.prs) {
      const id = `${p.repo?.toLowerCase() ?? ""}#${p.num}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const h = p.repo ? hub?.prs[prKey(p.repo, p.num)] : undefined;
      all.push({ p, l, state: h?.state ?? null, at: h?.mergedAt ?? h?.closedAt ?? null });
    }
  const shown = (e: PrEntry): boolean =>
    e.state === "OPEN" ||
    (e.state === "MERGED" && e.at !== null && now - e.at < WEEK_MS) ||
    (e.state === null && e.l.status !== "done");
  return { shown: all.filter(shown), past: all.filter((e) => !shown(e)) };
}

/** The project's events, its PRs merged this week and `talk`, oldest first. */
export function timeline(g: Pick<ProjectGroup, "events">, merged: PrEntry[], talk: HubEvent[]): HubEvent[] {
  const m: HubEvent[] = merged.flatMap((e) =>
    e.state === "MERGED" && e.at ? [{ at: e.at, kind: "merged", text: `#${e.p.num} ${e.l.key}` }] : [],
  );
  return [...g.events, ...m, ...talk].sort((a, b) => a.at - b.at);
}

export const askText = (a: Ask): string => `${a.id} ${a.question}`;
