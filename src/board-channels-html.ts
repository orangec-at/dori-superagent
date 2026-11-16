import { hrefOf, type View } from "./board-list-html.ts";
import { chanProject } from "./board-projects-html.ts";
import type { BoardState } from "./board-state.ts";
import { ago, esc, form } from "./board-thread-html.ts";
import { type Channel, type ChannelView, chanLabel, type SourceView } from "./channel-source.ts";
import { SEND_MAX } from "./discord-sync.ts";

/**
 * The 채널 tab: every messenger source the board has (Discord, Slack), each with its channels, every channel's threads
 * under it, then its DMs; the selected one opens with its messages and a composer that posts to POST /chan. A viewer
 * who may not write sees only why ("locked").
 */
type Owners = Pick<BoardState, "projects" | "bots">;
export type Sources = SourceView[] | "locked" | null;

const threadTags = (c: Channel): string =>
  `${c.archived ? '<span class="tag">보관</span>' : ""}${c.locked ? '<span class="tag">잠김</span>' : ""}`;
const icon = (c: Channel): string => (c.kind === "dm" ? "@" : c.kind === "thread" ? "↳" : "#");

/**
 * When a channel's new messages arrived: the others' messages after the operator's last one there. board.js keeps only
 * those after the channel was last opened on this device.
 */
export function unreadAts(c: Channel): number[] {
  const last = c.messages.findLastIndex((m) => m.mine);
  return c.messages
    .slice(last + 1)
    .filter((m) => !m.mine)
    .map((m) => m.at);
}

const unreadBadge = (c: Channel): string => {
  const ats = unreadAts(c);
  return `<span class="unr" data-d="${esc(c.key)}" data-ats="${ats.join(",")}" aria-label="새 글"${ats.length ? "" : " hidden"}>${ats.length > 99 ? "99+" : ats.length}</span>`;
};

/** The one source whose copy lists `key`, with that channel. */
export function openChannel(vs: Sources, key: string | null): [SourceView, Channel] | null {
  if (!key || !Array.isArray(vs)) return null;
  for (const v of vs) {
    const c = v.view.channels.find((x) => x.key === key);
    if (c) return [v, c];
  }
  return null;
}

function sourceList(src: SourceView, s: Owners, v: View, now: number): string {
  const d: ChannelView = src.view;
  const row = (c: Channel): string => {
    const last = c.messages.at(-1);
    const proj = chanProject(c, d, s);
    return `<a class="row${c.kind === "thread" ? " sub" : ""}${v.d === c.key ? " on" : ""}" href="${esc(hrefOf(v, { d: c.key, c: null, m: null }))}#end"><span class="chan">${icon(c)}</span><span class="rb">
<span class="rt"><b>${esc(chanLabel(c))}</b>${threadTags(c)}${proj ? `<span class="tag">${esc(proj)}</span>` : ""}${unreadBadge(c)}<span class="ago">${last ? ago(now, last.at) : ""}</span></span>
<span class="rs">${last ? `${esc(last.author)}: ${esc(last.text.replace(/\s+/g, " ").slice(0, 120))}` : "아직 메시지가 없어요"}</span></span></a>`;
  };
  // A channel's threads follow it, in the copy's order (the source decides: newest activity first).
  const chans = (kind: "channel" | "dm"): string =>
    d.channels
      .filter((c) => c.kind === kind)
      .map(
        (c) =>
          row(c) +
          d.channels
            .filter((t) => t.kind === "thread" && t.parent === c.key)
            .map(row)
            .join(""),
      )
      .join("");
  const notes = `${d.error ? `<p class="note">${esc(d.error)} · 마지막 동기화 ${d.syncedAt ? ago(now, d.syncedAt) : "없음"}</p>` : ""}${d.skipped.length ? `<p class="note">못 읽은 곳: ${esc(d.skipped.join(", "))} · 나머지는 계속 동기화해요</p>` : ""}`;
  const n = d.channels.filter((c) => c.kind !== "thread").length;
  return `<h3 class="sec src" id="src-${esc(src.id)}"><span>${esc(src.label)} <span>${n}</span></span></h3>${notes}${chans("channel") + chans("dm") || `<p class="note">읽을 수 있는 채널이 없어요.</p>`}`;
}

export function channelsList(vs: Sources, s: Owners, v: View, now: number): string {
  if (vs === "locked") return `<p class="note">채널·DM은 허용된 계정·기기로 열어야 보여요.</p>`;
  if (!vs?.length) return `<p class="note">이 보드에 연결된 메신저가 없어요.</p>`;
  // With more than one source, chips jump to each one's section (a phone would otherwise scroll past all of Discord).
  const chips =
    vs.length > 1
      ? `<nav class="chips">${vs.map((x) => `<a class="chip" href="#src-${esc(x.id)}">${esc(x.label)} ${x.view.channels.filter((c) => c.kind !== "thread").length}</a>`).join("")}</nav>`
      : "";
  return chips + vs.map((src) => sourceList(src, s, v, now)).join("");
}

/** A channel, thread or DM of one source: its messages and a composer that posts to POST /chan. */
export function channelPane(
  src: SourceView,
  c: Channel,
  s: Owners,
  token: string | null,
  now: number,
  back: string,
): string {
  const d = src.view;
  const proj = chanProject(c, d, s);
  const msgs = c.messages
    .map((m) =>
      m.mine
        ? `<div class="msg me"><div class="bubble">${esc(m.text)}</div><div class="meta">${esc(m.author)} · ${ago(now, m.at)}</div></div>`
        : `<div class="msg them dmsg"><div class="mb"><span class="who">${esc(m.author)}${m.bot ? ' <span class="tag">봇</span>' : ""}</span><div class="text">${esc(m.text)}</div><span class="meta">${ago(now, m.at)}</span></div></div>`,
    )
    .join("\n");
  const synced = d.syncedAt ? `동기화 ${ago(now, d.syncedAt)}` : "동기화 전";
  // Discord reopens an archived thread a message is posted to, and refuses one in a locked thread.
  const note = c.locked
    ? `<p class="note">잠긴 스레드라 보드에서 보낼 수 없어요.</p>`
    : c.archived
      ? `<p class="note">보관된 스레드예요. 보내면 ${esc(src.label)}에서 다시 열려요.</p>`
      : "";
  const composer = c.locked
    ? ""
    : form(
        "/chan",
        token,
        `<input type="hidden" name="d" value="${esc(c.key)}"><div class="box"><textarea name="text" rows="1" maxlength="${SEND_MAX}" required placeholder="${esc(`${chanLabel(c, d)}에 보내기…`)}" aria-label="${esc(src.label)} 메시지"></textarea><button class="send" aria-label="보내기">↑</button></div>`,
        "composer",
      );
  return `<header class="rec-h"><a class="back" href="${esc(back)}" aria-label="목록으로">←</a><span class="chan">${icon(c)}</span>
<div class="title"><b>${esc(chanLabel(c, d))}</b><span class="meta">${proj ? `${esc(proj)} · ` : ""}${c.kind === "thread" ? `스레드${c.archived ? " · 보관됨" : ""}${c.locked ? " · 잠김" : ""} · ` : ""}${esc(src.label)} · ${synced}</span></div></header>
<section class="thread" id="chat" data-seen="${esc(c.key)}" data-at="${c.messages.at(-1)?.at ?? 0}">${msgs || `<p class="note">아직 메시지가 없어요.</p>`}<span id="end"></span></section>
${note}${composer}`;
}
