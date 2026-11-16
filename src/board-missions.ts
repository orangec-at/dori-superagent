import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./agents.ts";
import {
  assignmentOf,
  type BotCard,
  botLabel,
  delegateSummary,
  delegations,
  firstLine,
  kstDate,
} from "./board-bots.ts";
import {
  actorOf,
  briefTitle,
  firstUrl,
  issueLinks,
  mentionsIssue,
  museInbox,
  prKeys,
  tagOf,
  withoutTag,
} from "./board-mission-sources.ts";
import { lanePrs } from "./board-prs.ts";
import { laneStuck, missionCards } from "./board-mission-cards.ts";
import { NO_ASSIGNMENT, type StandingCard } from "./board-status.ts";
import { DAY, leadState, loadLeads, owns, type StandingLead } from "./standing.ts";
import type { Mission, MissionCard, Step, StepState } from "./board-mission-types.ts";
import type { Store } from "./store.ts";
import type { Lane } from "./store-types.ts";

type Draft = {
  id: string;
  title: string;
  steps: Step[];
  stuck: boolean;
  running: boolean;
  pending: boolean;
  needs: string | null;
};

const WINDOW_MS = 7 * DAY;
const MISSIONS_SHOWN = 40;
const ASSIGN_TAG = /^아침 배정 (\d{4}-\d{2}-\d{2})$/;

type AddStep = (
  m: Draft,
  at: number,
  from: string,
  to: string,
  what: string,
  state: StepState,
  href?: string | null,
) => void;

/**
 * Every mission of the last week, newest first, and the mission card of each bot, standing lead and lane. A mission is
 * what the existing records already tie together: a `--mission` tag, the `[tag]` a delegate instruction starts with
 * (the morning assignment `[아침 배정 <date>]`), else the lane key. Review receipts join the lane whose PR they name,
 * issue links in an answer become a hand-over to that repository, and a Muse inbox line joins the mission whose issue
 * number it mentions.
 */
export function missionState(
  store: Store,
  bots: BotCard[],
  standing: StandingCard[],
  now: number,
  agents: Agent[],
  imgs: Record<string, string> = {},
): { missions: Mission[]; cards: Record<string, MissionCard> } {
  const home = store.root;
  let leads: StandingLead[] = [];
  try {
    leads = loadLeads(home);
  } catch {}
  const actor = actorOf(agents, imgs);
  const drafts = new Map<string, Draft>();
  const draft = (id: string, title: string): Draft => {
    const found = drafts.get(id);
    if (found) return found;
    const d: Draft = { id, title, steps: [], stuck: false, running: false, pending: false, needs: null };
    drafts.set(id, d);
    return d;
  };
  const step: AddStep = (m, at, from, to, what, state, href = null) =>
    void m.steps.push({ at, from, to, what: firstLine(what) || "-", state, href });
  const issues = (m: Draft, at: number, from: string, text: string) => {
    for (const i of issueLinks(text))
      if (!m.steps.some((s) => s.to === `gh:${i.repo}` && s.href === i.url))
        step(m, at, from, `gh:${i.repo}`, i.comment ? `이슈 #${i.num} 댓글` : `이슈 #${i.num}`, "ok", i.url);
  };
  // One read of each standing lead's state per board build, however many lanes it owns.
  const states = new Map<string, ReturnType<typeof leadState>>();
  const stateOf = (domain: string) => {
    if (!states.has(domain)) states.set(domain, leadState(home, domain));
    return states.get(domain);
  };
  const ownerOf = (l: Lane): string => {
    const def = leads.find((d) => owns(store, d, l.key));
    const s = def ? stateOf(def.domain) : undefined;
    return def && s && s.startedAt <= l.createdAt ? `standing:${def.domain}` : "lead";
  };

  // Lanes: lead (or the standing lead that owns it) -> lane -> back, with the PRs it names.
  const prMission = new Map<string, { mission: string; lane: string; url: string }>();
  const lanes = store.lanes().filter((l) => now - l.lastActivityAt < WINDOW_MS);
  const laneTitles = new Map<string, string>();
  for (const l of lanes) {
    const title = briefTitle(l.brief, l.key);
    laneTitles.set(l.key, title);
    const m = draft(l.mission ? `mission:${l.mission}` : `lane:${l.key}`, l.mission ?? title);
    const [me, owner] = [`lane:${l.key}`, ownerOf(l)];
    for (const e of l.log) {
      if (e.kind === "start" || e.kind === "adopt")
        step(m, e.at, owner, me, `${e.kind === "start" ? "시작" : "맡김"} · ${title}`, "ok");
      else if (e.kind === "report") step(m, e.at, me, owner, e.text, "ok");
      else if (e.kind === "ready") {
        const href = l.final?.evidence[0] ?? firstUrl(e.text);
        step(m, e.at, me, "lead", `READY · ${e.text}`, l.status === "ready" ? "needs" : "ok", href);
      } else if (e.kind === "done") step(m, e.at, "lead", me, "닫음", "ok");
      else if (e.kind === "lost") step(m, e.at, me, owner, "끊김", "stuck");
      if (e.kind === "report" || e.kind === "ready") issues(m, e.at, me, e.text);
    }
    if (l.status === "working" || l.status === "ready") m.running = true;
    if (laneStuck(l)) m.stuck = true;
    if (l.status === "ready") m.needs ??= me;
    for (const p of lanePrs(l))
      if (p.repo && p.url) prMission.set(`${p.repo}#${p.num}`, { mission: m.id, lane: me, url: p.url });
  }
  const reviewer = agents.find((a) => a.role === "review");
  const reviewed = new Set<string>();
  for (const r of store.receipts()) {
    const pr = prMission.get(r.pr);
    if (!pr || now - r.at > WINDOW_MS) continue;
    const m = drafts.get(pr.mission)!;
    const who = reviewer ? `bot:${reviewer.name}` : "lead";
    step(m, r.at, pr.lane, who, `PR #${r.pr.split("#")[1]} 리뷰 요청`, "ok", pr.url);
    const verdict = `리뷰 ${r.verdict} @${r.sha.slice(0, 7)}`;
    step(m, r.at, who, pr.lane, verdict, r.verdict === "BLOCK" ? "stuck" : "ok", pr.url);
    if (!reviewed.has(r.pr) && r.verdict === "BLOCK") m.stuck = true;
    reviewed.add(r.pr);
  }

  // Delegations: lead -> bot and the bot's answer back, grouped by --mission, then [tag], then the PR they name.
  const assignDates = new Set([kstDate(now)]);
  const lastFailed = new Map<Draft, Map<string, boolean>>();
  for (const d of delegations(home)) {
    const at = Date.parse(d.at);
    if (!(now - at < WINDOW_MS)) continue;
    const tag = tagOf(d.text);
    const date = tag ? ASSIGN_TAG.exec(tag)?.[1] : undefined;
    if (date) assignDates.add(date);
    const byPr = prKeys(d.text)
      .map((k) => prMission.get(k)?.mission)
      .find(Boolean);
    const id = d.mission ? `mission:${d.mission}` : tag ? `tag:${tag}` : (byPr ?? `d:${d.agent}:${at}`);
    // A --mission run that is also a morning assignment shows in both, so the assignment does not wait on it.
    const targets = [draft(id, d.mission ?? tag ?? withoutTag(d.text))];
    if (d.mission && tag && date) targets.push(draft(`tag:${tag}`, tag));
    const bot = `bot:${d.agent}`;
    const failed = d.outcome !== "ok";
    const answer = failed ? (d.outcome === "timeout" ? "시간 초과" : "실패") : delegateSummary(d.output);
    for (const m of targets) {
      step(m, at, "lead", bot, `지시 · ${withoutTag(d.text)}`, "ok");
      step(m, at, bot, "lead", answer, failed ? "stuck" : "ok", firstUrl(d.output));
      lastFailed.set(m, (lastFailed.get(m) ?? new Map()).set(bot, failed));
      issues(m, at, bot, d.output);
    }
  }

  // A retry that succeeded clears an earlier failure: only each bot's latest run counts, as with review receipts.
  for (const [m, bots] of lastFailed) if ([...bots.values()].some(Boolean)) m.stuck = true;

  // The morning assignment file: who was given what, and the result line the lead wrote for each bot.
  for (const date of assignDates) {
    const file = join(home, "out", `daily-assign-${date}.md`);
    if (!existsSync(file)) continue;
    const md = readFileSync(file, "utf8");
    const written = statSync(file).mtimeMs;
    for (const a of agents) {
      const { today, result } = assignmentOf(md, botLabel(a));
      if (!today || NO_ASSIGNMENT.test(today)) continue;
      const m = draft(`tag:아침 배정 ${date}`, `아침 배정 ${date}`);
      const bot = `bot:${a.name}`;
      const handed = m.steps.filter((s) => s.from === bot || s.to === bot).at(-1)?.at;
      if (handed === undefined) {
        step(m, Date.parse(`${date}T09:00:00+09:00`), "lead", bot, `배정 · ${today}`, "wait");
        if (!result) m.pending = true;
      }
      if (!result) continue;
      const bad = result.startsWith("⚠️") || result.startsWith("❌");
      // The result is clipped for the card; its links come from the whole line.
      const line = md.split("\n").findLast((l) => l.startsWith(`- ${botLabel(a)} `)) ?? result;
      step(m, (handed ?? written) + 1, bot, "lead", `결과 · ${result}`, bad ? "stuck" : "ok", firstUrl(line));
      if (bad) m.stuck = true;
      issues(m, (handed ?? written) + 1, bot, line);
    }
  }

  // Muse: an inbox line that names `#N` joins the mission that already links that repository's issue N.
  for (const line of museInbox(home)) {
    if (now - line.at > WINDOW_MS) continue;
    for (const n of new Set([...line.text.matchAll(/#(\d+)/g)].map((x) => Number(x[1]))))
      for (const m of drafts.values())
        if (
          m.steps.some((s) =>
            issueLinks(s.href ?? "").some((i) => i.num === n && mentionsIssue(line.text, i.repo, n)),
          ) &&
          !m.steps.some((s) => s.to === "muse" && s.at === line.at)
        )
          step(m, line.at, "lead", "muse", `받은편지함 · ${line.text}`, "ok");
  }

  const missions = [...drafts.values()]
    .map((m): Mission => {
      const steps = m.steps.sort((a, b) => a.at - b.at);
      const ids = [...new Set(steps.flatMap((s) => [s.from, s.to]))];
      return {
        id: m.id,
        title: firstLine(m.title),
        status: m.stuck ? "막힘" : m.running ? "진행" : m.pending ? "대기" : "완료",
        at: steps.at(-1)?.at ?? 0,
        actors: ids.map(actor),
        steps,
        needs: m.needs,
      };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, MISSIONS_SHOWN);
  const ownerLabel = (l: Lane): string => actor(ownerOf(l)).label;
  const cards = missionCards({
    store,
    agents,
    leads,
    bots,
    standing,
    lanes,
    missions,
    now,
    titles: laneTitles,
    ownerLabel,
  });
  return { missions, cards };
}
