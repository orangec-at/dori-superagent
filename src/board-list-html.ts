import type { AgentActivity } from "./board-agents.ts";
import { agentsTab } from "./board-agents-html.ts";
import type { LinksRead } from "./board-links-file.ts";
import { linksList } from "./board-links-html.ts";
import { avatar, rowMission, statusPill } from "./board-mission-html.ts";
import type { Mission, MissionCard } from "./board-mission-types.ts";
import type { ProjectGroup } from "./board-state.ts";
import type { Row, Section } from "./board-status.ts";
import { FILTERS, type TaskFilter } from "./board-tasks.ts";
import { rowAvatar, strip } from "./board-detail-html.ts";
import { ago, esc, mark } from "./board-thread-html.ts";

export type Tab = "work" | "agent" | "proj" | "mission" | "pr" | "backlog" | "map";
export type Filter = "all" | "mine" | "working";
/**
 * What the page shows: the list tab, its filter, and the selected row or mission (null: the list alone on a phone);
 * on the 프로젝트 tab, the selected project `p` or Discord channel key `d`, and the project's task filter `k`.
 */
export type View = {
  tab: Tab;
  f: Filter;
  c: string | null;
  m: string | null;
  p: string | null;
  d: string | null;
  k?: TaskFilter | null;
};
const TABS: readonly Tab[] = ["agent", "proj", "mission", "pr", "backlog", "map"];

export function viewOf(params: URLSearchParams): View {
  const tab = params.get("tab");
  const f = params.get("f");
  const k = params.get("k");
  return {
    tab: TABS.find((t) => t === tab) ?? "work",
    f: f === "mine" || f === "working" ? f : "all",
    c: params.get("c"),
    m: params.get("m"),
    p: tab === "proj" ? params.get("p") : null,
    d: tab === "proj" ? params.get("d") : null,
    k: tab === "proj" ? (FILTERS.find(([x]) => x === k)?.[0] ?? null) : null,
  };
}

export function hrefOf(v: View, over: Partial<View> = {}): string {
  const n = { ...v, ...over };
  const q = new URLSearchParams();
  if (n.tab !== "work") q.set("tab", n.tab);
  if (n.f !== "all") q.set("f", n.f);
  if (n.c) q.set("c", n.c);
  if (n.m) q.set("m", n.m);
  if (n.tab === "proj" && n.p) q.set("p", n.p);
  if (n.tab === "proj" && n.d) q.set("d", n.d);
  if (n.tab === "proj" && n.k && n.k !== "all") q.set("k", n.k);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

const SECTIONS: [Section, string][] = [
  ["needs", "재일 님 차례"],
  ["unread", "새 결과"],
  ["working", "작업 중"],
  ["revisit", "다시 볼 것"],
  ["idle", "쉬는 중"],
];

const rowTarget = (r: Row): string => (r.kind === "ask" ? "lead" : r.id);

function rowLink(
  r: Row,
  v: View,
  now: number,
  selected: string | null,
  imgs: Record<string, string>,
  card?: MissionCard,
): string {
  const target = rowTarget(r);
  const anchor = r.kind === "ask" ? `#${esc(r.id.replace(":", "-"))}` : "";
  return `<a class="row${target === selected && r.kind !== "ask" ? " on" : ""}" href="${esc(hrefOf(v, { c: target, m: null }))}${anchor}">${rowAvatar(r, imgs)}<span class="rb">
<span class="rt"><b>${esc(r.title)}</b>${r.prs[0] ? `<span class="pr">⑂ #${r.prs[0].num}</span>` : ""}<span class="ago">${r.at ? ago(now, r.at) : ""}</span></span>
<span class="rs"><span class="proj">${esc(r.project)}</span> <span class="w s-${r.section}">${esc(r.word)}</span> · ${esc(r.line)}</span>${rowMission(card)}</span></a>`;
}

function missionTab(missions: Mission[], v: View, now: number): string {
  const html = missions
    .map(
      (m) =>
        `<a class="row${m.id === v.m ? " on" : ""}" href="${esc(hrefOf(v, { m: m.id, c: null }))}#mtop"><span class="avs">${m.actors
          .slice(0, 4)
          .map((a) => avatar(a, "sm"))
          .join(
            "",
          )}</span><span class="rb"><span class="rt"><b>${esc(m.title)}</b><span class="ago">${ago(now, m.at)}</span></span>` +
        `<span class="rs">${statusPill(m.status)} ${m.needs ? '<span class="w s-needs">재일 님 차례</span> · ' : ""}참여 ${m.actors.length} · 단계 ${m.steps.length}</span></span></a>`,
    )
    .join("");
  return html || `<p class="note">이번 주에 묶인 미션이 없어요.</p>`;
}

function workTab(
  rows: Row[],
  v: View,
  now: number,
  selected: string | null,
  cards: Record<string, MissionCard>,
  imgs: Record<string, string>,
): string {
  const [lead, ...rest] = rows;
  const mine = rest.filter((r) => r.section === "needs");
  const working = rest.filter((r) => r.section === "working");
  const chip = (f: Filter, label: string, n: number): string =>
    `<a class="chip${v.f === f ? " on" : ""}${f === "mine" && n ? " hot" : ""}" href="${esc(hrefOf(v, { f }))}">${label} ${n}</a>`;
  const chips = `<nav class="chips">${chip("all", "전체", rest.length)}${chip("mine", "내 차례", mine.length)}${chip("working", "작업 중", working.length)}</nav>`;
  const shown = v.f === "mine" ? mine : v.f === "working" ? working : rest;
  const sections = SECTIONS.map(([s, label]) => {
    const list = shown.filter((r) => r.section === s);
    if (!list.length) return "";
    const head = `<span class="${s === "needs" ? "needs" : ""}">${label} <span>${list.length}</span></span>`;
    const links = list.map((r) => rowLink(r, v, now, selected, imgs, cards[r.id])).join("");
    return s === "idle"
      ? `<details class="sec"><summary>${head}</summary>${links}</details>`
      : `<h3 class="sec">${head}</h3>${links}`;
  }).join("");
  const empty = v.f === "mine" && !mine.length ? `<p class="note">지금은 재일 님 차례가 없어요.</p>` : "";
  return `${strip(rows, (c) => hrefOf(v, { c, m: null }), imgs)}${chips}${lead ? rowLink(lead, v, now, selected, imgs) : ""}${sections}${empty}`;
}

function prTab(rows: Row[], v: View, now: number, selected: string | null): string {
  const groups: [string, (r: Row) => boolean][] = [
    ["재일 님 차례", (r) => r.section === "needs"],
    ["에이전트 작업 중", (r) => r.section === "working" || r.section === "revisit"],
    ["완료", (r) => r.section === "unread" || r.section === "idle"],
  ];
  const lanes = rows.filter((r) => r.kind === "lane" && r.prs.length);
  const html = groups
    .map(([label, test], i) => {
      const list = lanes.filter(test).flatMap((r) => r.prs.map((p) => ({ r, p })));
      if (!list.length) return "";
      const rowsHtml = list
        .map(
          ({ r, p }) =>
            `<a class="row${r.id === selected ? " on" : ""}" href="${esc(hrefOf(v, { c: r.id, m: null }))}">${mark(r)}<span class="rb"><span class="rt"><b>#${p.num} ${esc(r.title)}</b>` +
            `${p.repo ? `<span class="repo">${esc(p.repo.split("/")[1] ?? p.repo)}</span>` : ""}<span class="ago">${r.at ? ago(now, r.at) : ""}</span></span>` +
            `<span class="rs"><span class="w s-${r.section}">${esc(r.word)}</span> · ${esc(r.line)}</span></span></a>`,
        )
        .join("");
      return `<h3 class="sec"><span class="${i === 0 ? "needs" : ""}">${label} <span>${list.length}</span></span></h3>${rowsHtml}`;
    })
    .join("");
  return html || `<p class="note">lane이 연 PR이 없어요.</p>`;
}

function backlogTab(projects: ProjectGroup[]): string {
  const html = projects
    .filter((g) => g.backlog.length)
    .map(
      (g) =>
        `<h3 class="sec"><span>${esc(g.name)} <span>${g.backlog.length}</span></span></h3>` +
        g.backlog
          .map(
            (i) =>
              `<div class="row">${mark({ section: i.decision ? "needs" : "idle", health: "idle" })}<span class="rb"><span class="rt"><b>${esc(i.title)}</b></span>` +
              `<span class="rs"><span class="proj">p${i.priority}</span> <span class="w">${esc(i.status)}</span>${i.decision ? ` · 결정 필요: ${esc(i.decision)}` : ""}</span></span></div>`,
          )
          .join(""),
    )
    .join("");
  return html || `<p class="note">열린 백로그가 없어요.</p>`;
}

/** The list pane: tabs, then the work rows (with the My-turn filter), the missions, the PRs lanes opened, or the backlog. */
export function listPane(
  rows: Row[],
  s: {
    projects: ProjectGroup[];
    missions: Mission[];
    cards: Record<string, MissionCard>;
    avatars: Record<string, string>;
    agents: AgentActivity[];
    links?: LinksRead;
    /** The 프로젝트 tab's body, rendered by the page (it needs the Discord copy). */
    proj?: string;
  },
  v: View,
  now: number,
  selected: string | null,
): string {
  const { projects } = s;
  const prCount = rows.reduce((n, r) => n + (r.kind === "lane" ? r.prs.length : 0), 0);
  const backlogCount = projects.reduce((n, g) => n + g.backlog.length, 0);
  const tab = (t: Tab, label: string, n: number): string =>
    `<a class="tab${v.tab === t ? " on" : ""}" href="${esc(hrefOf(v, { tab: t, f: "all" }))}">${label}${n ? ` ${n}` : ""}</a>`;
  const body =
    v.tab === "agent"
      ? agentsTab(s.agents, s.avatars, now)
      : v.tab === "proj"
        ? (s.proj ?? "")
        : v.tab === "mission"
          ? missionTab(s.missions, v, now)
          : v.tab === "pr"
            ? prTab(rows, v, now, selected)
            : v.tab === "backlog"
              ? backlogTab(projects)
              : v.tab === "map"
                ? linksList(s.links ?? null, s.avatars)
                : workTab(rows, v, now, selected, s.cards, s.avatars);
  const active = s.missions.filter((m) => m.status !== "완료").length;
  const busy = s.agents.filter((a) => a.state === "working").length;
  return `<nav class="tabs">${tab("work", "작업", 0)}${tab("agent", "에이전트", busy)}${tab("proj", "프로젝트", 0)}${tab("mission", "미션", active)}${tab("pr", "PR", prCount)}${tab("backlog", "백로그", backlogCount)}${tab("map", "연결", 0)}</nav>${body}`;
}
