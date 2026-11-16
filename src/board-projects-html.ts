import { badgeHtml, HUB_STYLE, prSection, rowLine, statusCard, timelineHtml } from "./board-hub-html.ts";
import { badgeOf, type HubEvent } from "./board-hub-state.ts";
import { hrefOf, type View } from "./board-list-html.ts";
import { avatar } from "./board-mission-html.ts";
import type { Mission } from "./board-mission-types.ts";
import { messageProject, OTHER } from "./board-projects.ts";
import type { BoardState, ProjectGroup } from "./board-state.ts";
import { projectTasks } from "./board-tasks.ts";
import { milestonesHtml, overviewFacts, TASKS_STYLE, taskBoard } from "./board-tasks-html.ts";
import { ago, esc } from "./board-thread-html.ts";
import { type Channel, type ChannelMessage, type ChannelView, chanLabel } from "./channel-source.ts";

/**
 * The 프로젝트 tab: every project with its lanes, PRs, backlog, missions, bots and recent talk from the 채널 tab's
 * messengers (Discord, Slack), each talk row linking to its channel there. A channel belongs to the project it is
 * named after (by project name, a lead's key prefix, one of its bots or the first word of its lanes' keys), a thread to
 * its parent's (else the one its name gives), and a projects.json alias for the id overrides both; a message belongs to
 * the project its text names, else its channel's.
 */
export const PROJECTS_STYLE = `.pjm{display:flex;flex-direction:column;gap:2px}.pjd .sec{margin:18px 0 4px}.pjd .row{padding:7px 6px}
.chan{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--panel);color:var(--muted);font-weight:700}
.tag{font-size:12px;padding:0 7px;border-radius:999px;background:var(--panel);color:var(--muted);white-space:nowrap}.dmsg .who{font-weight:600;font-size:13px;padding:0}
.dmsg .meta{margin-left:6px}.tabs{overflow-x:auto;scrollbar-width:none}.tab{white-space:nowrap;flex:1 0 auto;padding:7px 8px}
.unr{flex:none;min-width:18px;padding:0 6px;border-radius:999px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;text-align:center}.unr[hidden]{display:none}
.pjn{margin:12px 0 4px}.pjm a{color:inherit}.row.sub{padding-left:26px}.row.sub .chan{width:24px;height:24px;font-size:13px}
@media (min-width:768px){.tabs{flex-wrap:wrap}}
@media (min-width:1024px){.app.pj{grid-template-columns:320px minmax(0,1fr)}}${HUB_STYLE}${TASKS_STYLE}`;

const RECENT_TALK = 6;
const TALK_CHARS = 120;
const WEEK_MS = 7 * 86_400_000;
const word = (s: string): string => s.toLowerCase().split("-")[0] ?? "";

export function channelProject(name: string, s: Pick<BoardState, "projects" | "bots">): string | null {
  const n = name.toLowerCase();
  const live = s.projects.filter((g) => g.name !== OTHER);
  const bot = s.bots.find((b) => b.label.toLowerCase() === n || b.name.toLowerCase() === n)?.name;
  return (
    live.find((g) => g.name === n || g.prefixes.some((p) => n.startsWith(p)))?.name ??
    (bot ? live.find((g) => g.bots.includes(bot))?.name : undefined) ??
    live.find((g) => [...g.lanes, ...g.recent].some((l) => word(l.key) === n))?.name ??
    null
  );
}

type Owners = Pick<BoardState, "projects" | "bots">;
const parentOf = (c: Channel, d: ChannelView): Channel | undefined =>
  c.parent ? d.channels.find((p) => p.key === c.parent) : undefined;

/** The project a channel, DM or thread belongs to: its alias, else a thread's parent's, else its name's. */
export function chanProject(c: Channel, d: ChannelView, s: Owners): string | null {
  const parent = parentOf(c, d);
  return c.project ?? (parent ? chanProject(parent, d, s) : null) ?? channelProject(c.name, s);
}

type Talk = ChannelMessage & { channel: Channel };

function talkOf(g: ProjectGroup, s: BoardState, d: ChannelView | null): Talk[] {
  if (!d) return [];
  return d.channels
    .flatMap((c) => {
      const home = chanProject(c, d, s);
      return c.messages
        .filter((m) => (messageProject(m.text, s.projects) ?? home) === g.name)
        .map((m) => ({ ...m, channel: c }));
    })
    .sort((a, b) => a.at - b.at)
    .slice(-RECENT_TALK);
}

const missionsOf = (g: ProjectGroup, missions: Mission[]): Mission[] => {
  const ids = new Set([...g.lanes, ...g.recent].map((l) => `lane:${l.key}`));
  return missions.filter((m) => m.actors.some((a) => ids.has(a.id)));
};

export function projectsList(s: BoardState, v: View, now: number): string {
  const projects = s.projects
    .map(
      (g) =>
        `<a class="row${v.p === g.name ? " on" : ""}" href="${esc(hrefOf(v, { p: g.name, c: null, m: null }))}#ptop">${avatar({ id: `project:${g.name}`, label: g.name, sub: "" })}<span class="rb">
<span class="rt"><b>${esc(g.name)}</b>${badgeHtml(badgeOf(g))}<span class="ago">${g.at ? ago(now, g.at) : ""}</span></span><span class="rs">${esc(rowLine(g))}</span></span></a>`,
    )
    .join("");
  return `<h3 class="sec"><span>프로젝트 <span>${s.projects.length}</span></span></h3>${projects || `<p class="note">진행 중인 프로젝트가 없어요.</p>`}`;
}

/** The project's recent Discord talk of the last week as timeline events, each linking to its channel. */
const talkEvents = (talk: Talk[], d: ChannelView | null, v: View, now: number): HubEvent[] =>
  talk
    .filter((m) => now - m.at <= WEEK_MS)
    .map((m) => {
      const t = m.text.replace(/\s+/g, " ");
      return {
        at: m.at,
        kind: "talk",
        text: `${m.author} · ${chanLabel(m.channel, d ?? undefined)}: ${t.length > TALK_CHARS ? `${t.slice(0, TALK_CHARS)}…` : t}`,
        href: `${hrefOf(v, { tab: "chan", d: m.channel.key, p: null, c: null, m: null })}#end`,
      };
    });

/**
 * The selected project: its status card first (on a phone too) with who runs it and the next due date, its milestones,
 * the tasks in four columns (forms for a writer: `token`), its PRs by state, the week's timeline (Discord talk
 * included) and missions.
 */
export function projectPane(
  g: ProjectGroup,
  s: BoardState,
  d: ChannelView | null,
  v: View,
  now: number,
  back: string,
  token: string | null = null,
): string {
  const sec = (label: string, n: number, body: string): string =>
    n ? `<h3 class="sec"><span>${label} <span>${n}</span></span></h3>${body}` : "";
  const tasks = projectTasks(g, s.bots, now);
  const missions = missionsOf(g, s.missions);
  const talk = talkEvents(talkOf(g, s, d), d, v, now);
  const meta = [g.repos.join(", "), g.bots.length ? `봇 ${g.bots.join(", ")}` : ""].filter(Boolean).join(" · ");
  const ext = (href: string, label: string, sub: string): string =>
    `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a> <span class="meta">${sub}</span></li>`;
  const refs = [
    ...g.links.map((l) => ext(l.url, l.label, "링크")),
    ...g.repos.map((r) => ext(`https://github.com/${r}`, r, "저장소")),
  ];
  return `<header class="rec-h" id="ptop"><a class="back" href="${esc(back)}" aria-label="목록으로">←</a><span class="hav">${avatar({ id: `project:${g.name}`, label: g.name, sub: "" })}</span>
<div class="title"><b>${esc(g.name)}</b><span class="meta">${esc(meta || "프로젝트")}</span></div></header>
<section class="thread pjd" id="chat">
${statusCard(g, s.hub, now, refs.length ? `<ul class="pjm">${refs.join("")}</ul>` : "", overviewFacts(g, s, tasks, now))}
${milestonesHtml(g.milestones, tasks, now)}
${g.lanes.length + g.backlog.length ? "" : `<p class="note">진행 중인 일 없음</p>`}
${taskBoard(g, tasks, v, token, now)}
${prSection(g, s.hub, now)}
${timelineHtml(g, s.hub, talk, now)}
${sec("미션", missions.length, missions.map((m) => `<a class="row" href="${esc(hrefOf(v, { tab: "mission", m: m.id, c: null, p: null, d: null }))}#mtop"><span class="rb"><span class="rt"><b>${esc(m.title)}</b><span class="ago">${ago(now, m.at)}</span></span><span class="rs">${esc(m.status)} · 참여 ${m.actors.length}</span></span></a>`).join(""))}
<span id="end"></span></section>`;
}
