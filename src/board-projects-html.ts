import { badgeHtml, HUB_STYLE, prSection, rowLine, statusCard, timelineHtml } from "./board-hub-html.ts";
import { badgeOf, type HubEvent } from "./board-hub-state.ts";
import { hrefOf, type View } from "./board-list-html.ts";
import { avatar } from "./board-mission-html.ts";
import type { Mission } from "./board-mission-types.ts";
import { OTHER } from "./board-projects.ts";
import type { BoardState, ProjectGroup, ProjectLane } from "./board-state.ts";
import { laneStatus } from "./board-status.ts";
import { ago, esc, form, mark } from "./board-thread-html.ts";
import { type DiscordChannel, type DiscordMessage, type DiscordView, SEND_MAX } from "./discord-sync.ts";

/**
 * The 프로젝트 tab: every project with its lanes, PRs, backlog, missions, bots and recent Discord talk, and every
 * Discord channel and DM of the board's copy. A channel belongs to the project it is named after (by project name, a
 * lead's key prefix, one of its bots or the first word of its lanes' keys); a message to the project its text names,
 * else its channel's.
 */
export const PROJECTS_STYLE = `.pjm{display:flex;flex-direction:column;gap:2px}.pjd .sec{margin:18px 0 4px}.pjd .row{padding:7px 6px}
.chan{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--panel);color:var(--muted);font-weight:700}
.tag{font-size:12px;padding:0 7px;border-radius:999px;background:var(--panel);color:var(--muted);white-space:nowrap}.dmsg .who{font-weight:600;font-size:13px;padding:0}
.dmsg .meta{margin-left:6px}.tabs{overflow-x:auto;scrollbar-width:none}.tab{white-space:nowrap;flex:1 0 auto;padding:7px 8px}
.unr{flex:none;min-width:18px;padding:0 6px;border-radius:999px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;text-align:center}.unr[hidden]{display:none}
.pjn{margin:12px 0 4px}.pjm a{color:inherit}
@media (min-width:768px){.tabs{flex-wrap:wrap}}
@media (min-width:1024px){.app.pj{grid-template-columns:320px minmax(0,1fr)}}${HUB_STYLE}`;

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

export function messageProject(text: string, projects: ProjectGroup[]): string | null {
  const t = text.toLowerCase();
  const live = projects.filter((g) => g.name !== OTHER);
  return (
    live.find(
      (g) => (g.name.length >= 4 && t.includes(g.name)) || g.prefixes.some((p) => p.length >= 3 && t.includes(p)),
    )?.name ??
    live.find((g) => [...g.lanes, ...g.recent].some((l) => l.key.length >= 5 && t.includes(l.key)))?.name ??
    null
  );
}

type Talk = DiscordMessage & { channel: DiscordChannel };

function talkOf(g: ProjectGroup, s: BoardState, d: DiscordView | null): Talk[] {
  if (!d) return [];
  return d.channels
    .flatMap((c) => {
      const home = channelProject(c.name, s);
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

const chanLabel = (c: DiscordChannel): string => (c.kind === "dm" ? `DM · ${c.name}` : `#${c.name}`);

/**
 * When a channel's new messages arrived: the others' messages after the operator's last one there. board.js keeps only
 * those after the channel was last opened on this device.
 */
export function unreadAts(c: DiscordChannel): number[] {
  const last = c.messages.findLastIndex((m) => m.mine);
  return c.messages
    .slice(last + 1)
    .filter((m) => !m.mine)
    .map((m) => m.at);
}

const unreadBadge = (c: DiscordChannel): string => {
  const ats = unreadAts(c);
  return `<span class="unr" data-d="${esc(c.key)}" data-ats="${ats.join(",")}" aria-label="새 글"${ats.length ? "" : " hidden"}>${ats.length > 99 ? "99+" : ats.length}</span>`;
};

export function projectsList(s: BoardState, d: DiscordView | "locked" | null, v: View, now: number): string {
  const projects = s.projects
    .map(
      (g) =>
        `<a class="row${v.p === g.name ? " on" : ""}" href="${esc(hrefOf(v, { p: g.name, d: null, c: null, m: null }))}#ptop">${avatar({ id: `project:${g.name}`, label: g.name, sub: "" })}<span class="rb">
<span class="rt"><b>${esc(g.name)}</b>${badgeHtml(badgeOf(g))}<span class="ago">${g.at ? ago(now, g.at) : ""}</span></span><span class="rs">${esc(rowLine(g))}</span></span></a>`,
    )
    .join("");
  const chans = (kind: "channel" | "dm"): string =>
    (d && d !== "locked" ? d.channels : [])
      .filter((c) => c.kind === kind)
      .map((c) => {
        const last = c.messages.at(-1);
        const proj = channelProject(c.name, s);
        return `<a class="row${v.d === c.key ? " on" : ""}" href="${esc(hrefOf(v, { d: c.key, p: null, c: null, m: null }))}#end"><span class="chan">${kind === "dm" ? "@" : "#"}</span><span class="rb">
<span class="rt"><b>${esc(chanLabel(c))}</b>${proj ? `<span class="tag">${esc(proj)}</span>` : ""}${unreadBadge(c)}<span class="ago">${last ? ago(now, last.at) : ""}</span></span>
<span class="rs">${last ? `${esc(last.author)}: ${esc(last.text.replace(/\s+/g, " ").slice(0, 120))}` : "아직 메시지가 없어요"}</span></span></a>`;
      })
      .join("");
  const discord = !d
    ? `<p class="note">Discord가 이 보드에 연결되지 않았어요.</p>`
    : d === "locked"
      ? `<p class="note">Discord 채널·DM은 허용된 계정·기기로 열어야 보여요.</p>`
      : `${d.error ? `<p class="note">${esc(d.error)} · 마지막 동기화 ${d.syncedAt ? ago(now, d.syncedAt) : "없음"}</p>` : ""}${chans("channel") + chans("dm") || `<p class="note">읽을 수 있는 채널이 없어요.</p>`}`;
  const count = d && d !== "locked" ? ` <span>${d.channels.length}</span>` : "";
  // Channels first: what was said is what the operator reads most; the projects follow.
  return `<h3 class="sec"><span>채널${count}</span></h3>${discord}<h3 class="sec"><span>프로젝트 <span>${s.projects.length}</span></span></h3>${projects || `<p class="note">진행 중인 프로젝트가 없어요.</p>`}`;
}

function laneRow(l: ProjectLane, now: number): string {
  const [health, section, w] = laneStatus(l, now);
  return `<a class="row" href="${esc(`/?c=${encodeURIComponent(`lane:${l.key}`)}`)}">${mark({ section, health })}<span class="rb"><span class="rt"><b>${esc(l.key)}</b>${l.prs[0] ? `<span class="pr">⑂ #${l.prs[0].num}</span>` : ""}<span class="ago">${ago(now, l.at)}</span></span>
<span class="rs"><span class="w s-${section}">${esc(w)}</span> · ${esc(l.first)}</span></span></a>`;
}

/** The project's recent Discord talk of the last week as timeline events. */
const talkEvents = (talk: Talk[], now: number): HubEvent[] =>
  talk
    .filter((m) => now - m.at <= WEEK_MS)
    .map((m) => {
      const t = m.text.replace(/\s+/g, " ");
      return {
        at: m.at,
        kind: "talk",
        text: `${m.author} · ${chanLabel(m.channel)}: ${t.length > TALK_CHARS ? `${t.slice(0, TALK_CHARS)}…` : t}`,
      };
    });

/**
 * The selected project: its status card first (on a phone too), then what is open, its PRs by state, the week's
 * timeline (Discord talk included), backlog and missions, and the week's finished lanes.
 */
export function projectPane(
  g: ProjectGroup,
  s: BoardState,
  d: DiscordView | null,
  v: View,
  now: number,
  back: string,
): string {
  const sec = (label: string, n: number, body: string, needs = false): string =>
    n ? `<h3 class="sec"><span class="${needs ? "needs" : ""}">${label} <span>${n}</span></span></h3>${body}` : "";
  const missions = missionsOf(g, s.missions);
  const talk = talkEvents(talkOf(g, s, d), now);
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
${statusCard(g, s.hub, now, refs.length ? `<ul class="pjm">${refs.join("")}</ul>` : "")}
${sec(
  "진행 중 lane",
  g.lanes.length,
  g.lanes.map((l) => laneRow(l, now)).join(""),
  g.lanes.some((l) => l.status !== "working"),
)}
${prSection(g, s.hub, now)}
${timelineHtml(g, s.hub, talk, now)}
${sec("백로그", g.backlog.length, g.backlog.map((i) => `<div class="row">${mark({ section: i.decision ? "needs" : "idle", health: "idle" })}<span class="rb"><span class="rt"><b>${esc(i.title)}</b></span><span class="rs">p${i.priority} · ${esc(i.status)}${i.decision ? ` · 결정 필요: ${esc(i.decision)}` : ""}</span></span></div>`).join(""))}
${sec("미션", missions.length, missions.map((m) => `<a class="row" href="${esc(hrefOf(v, { tab: "mission", m: m.id, c: null, p: null, d: null }))}#mtop"><span class="rb"><span class="rt"><b>${esc(m.title)}</b><span class="ago">${ago(now, m.at)}</span></span><span class="rs">${esc(m.status)} · 참여 ${m.actors.length}</span></span></a>`).join(""))}
${g.recent.length ? `<details class="sec"><summary>이번 주 완료 <span>${g.recent.length}</span></summary>${g.recent.map((l) => laneRow(l, now)).join("")}</details>` : ""}
${g.lanes.length + g.backlog.length ? "" : `<p class="note">진행 중인 일 없음</p>`}<span id="end"></span></section>`;
}

/** A Discord channel or DM: its messages and a composer that posts to POST /discord. */
export function channelPane(
  c: DiscordChannel,
  s: BoardState,
  d: DiscordView,
  token: string | null,
  now: number,
  back: string,
): string {
  const proj = channelProject(c.name, s);
  const msgs = c.messages
    .map((m) =>
      m.mine
        ? `<div class="msg me"><div class="bubble">${esc(m.text)}</div><div class="meta">${esc(m.author)} · ${ago(now, m.at)}</div></div>`
        : `<div class="msg them dmsg"><div class="mb"><span class="who">${esc(m.author)}${m.bot ? ' <span class="tag">봇</span>' : ""}</span><div class="text">${esc(m.text)}</div><span class="meta">${ago(now, m.at)}</span></div></div>`,
    )
    .join("\n");
  const synced = d.syncedAt ? `동기화 ${ago(now, d.syncedAt)}` : "동기화 전";
  const composer = form(
    "/discord",
    token,
    `<input type="hidden" name="d" value="${esc(c.key)}"><div class="box"><textarea name="text" rows="1" maxlength="${SEND_MAX}" required placeholder="${esc(`${chanLabel(c)}에 보내기…`)}" aria-label="Discord 메시지"></textarea><button class="send" aria-label="보내기">↑</button></div>`,
    "composer",
  );
  return `<header class="rec-h"><a class="back" href="${esc(back)}" aria-label="목록으로">←</a><span class="chan">${c.kind === "dm" ? "@" : "#"}</span>
<div class="title"><b>${esc(chanLabel(c))}</b><span class="meta">${proj ? `${esc(proj)} · ` : ""}Discord · ${synced}</span></div></header>
<section class="thread" id="chat" data-seen="${esc(c.key)}" data-at="${c.messages.at(-1)?.at ?? 0}">${msgs || `<p class="note">아직 메시지가 없어요.</p>`}<span id="end"></span></section>
${composer}`;
}
