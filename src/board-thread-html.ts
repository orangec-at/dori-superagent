import type { Ask } from "./asks.ts";
import type { Pr } from "./board-prs.ts";
import type { Row } from "./board-status.ts";
import type { Thread, ThreadItem } from "./board-thread.ts";

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function ago(now: number, at: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

/** A form that posts to the board; without a write token it is shown disabled, so a read-only viewer sees why. */
export const form = (action: string, token: string | null, body: string, cls = ""): string =>
  `<form method="post" action="${action}"${cls ? ` class="${cls}"` : ""}><input type="hidden" name="csrf" value="${esc(token ?? "")}">` +
  `<fieldset${token ? "" : " disabled"}>${body}</fieldset></form>`;

/** The status mark of a row: `!` when it is the operator's turn, a ring while at work, a dot otherwise. */
export const mark = (r: Pick<Row, "section" | "health">): string =>
  `<span class="ic s-${r.section} h-${r.health}" aria-hidden="true">${r.section === "needs" || r.health === "error" ? "!" : ""}</span>`;

export const prLabel = (p: Pr): string =>
  p.url
    ? `<a class="pr" href="${esc(p.url)}" rel="noopener" target="_blank">⑂ #${p.num}</a>`
    : `<span class="pr">⑂ #${p.num}</span>`;

const LONG = 700;
const body = (text: string): string =>
  text.length > LONG
    ? `${esc(text.slice(0, LONG))}…<details class="more"><summary>더 보기</summary>${esc(text.slice(LONG))}</details>`
    : esc(text);

const DELIVERY: Record<string, [string, string]> = {
  DELIVERED: ["전달됨", ""],
  QUEUED: ["수신함 대기", ""],
  HELD: ["확인 필요", " bad"],
};

const link = (url: string): string =>
  /^https?:\/\//.test(url) ? `<a href="${esc(url)}" rel="noopener" target="_blank">${esc(url)}</a>` : esc(url);

function askCard(a: Ask, now: number, token: string | null): string {
  const options = a.options
    .map(
      (o) =>
        `<li${o.key === a.recommend ? ' class="rec"' : ""}><b>${esc(o.key)}.</b> ${esc(o.text)}${o.key === a.recommend ? " <em>추천</em>" : ""}</li>`,
    )
    .join("");
  const rec = a.options.find((o) => o.key === a.recommend);
  const buttons =
    (rec ? `<button class="primary" name="choice" value="${esc(rec.key)}">추천대로 (${esc(rec.key)})</button>` : "") +
    a.options.map((o) => `<button name="choice" value="${esc(o.key)}">${esc(o.key)}</button>`).join("");
  const sent = a.sent ? `<p class="sent">보냄: ${esc(a.sent.choice)} · ${ago(now, a.sent.at)}</p>` : "";
  const more = a.link ? `<p><a href="${esc(a.link)}" rel="noopener" target="_blank">자세히 보기</a></p>` : "";
  return `<article class="ask" id="ask-${esc(a.id)}"><p class="kicker">결정 · ${esc(a.id)} · ${ago(now, a.createdAt)}</p>
<p class="q">${esc(a.question)}</p><ol class="opts">${options}</ol>${more}
${form("/decide", token, `<input type="hidden" name="id" value="${esc(a.id)}"><div class="buttons">${buttons}</div>`)}${sent}</article>`;
}

function item(i: ThreadItem, now: number, token: string | null): string {
  const when = (at: number | null): string => (at ? `<span class="meta">${ago(now, at)}</span>` : "");
  switch (i.t) {
    case "me": {
      const [label, cls] = DELIVERY[i.delivery ?? ""] ?? ["", ""];
      return `<div class="msg me"><div class="bubble">${body(i.text)}</div><div class="meta${cls}">${ago(now, i.at)}${label ? ` · ${label}` : ""}</div></div>`;
    }
    case "them":
      return `<div class="msg them"><div class="text">${body(i.text)}</div>${(i.links ?? []).map((u) => `<p class="ev">${link(u)}</p>`).join("")}${when(i.at)}</div>`;
    case "work":
      return `<details class="work"><summary>${esc(i.title)} ${when(i.at)}</summary><pre>${esc(i.body)}</pre>${i.href ? `<a href="${esc(i.href)}">기록 열기 →</a>` : ""}</details>`;
    case "ask":
      return askCard(i.ask, now, token);
    case "note":
      return `<p class="note">${esc(i.text)}</p>`;
  }
}

/** The record of the selected row: header, `top` (its mission card), what waits on the operator, its PRs, then its timeline. */
export function record(t: Thread, now: number, token: string | null, back: string, top = ""): string {
  const r = t.row;
  const items = (list: ThreadItem[]): string => list.map((i) => item(i, now, token)).join("\n");
  const waiting = t.waiting.length
    ? `<h3 class="needs">재일 님 차례 <span>${t.waiting.length}</span></h3>${items(t.waiting)}`
    : "";
  const prs = t.prs.length
    ? `<details class="prs"${r.section === "needs" ? " open" : ""}><summary>PR ${t.prs.length}</summary><ul>${t.prs
        .map((p) => `<li>${prLabel(p)} <span class="meta">${esc(p.repo ?? "")}</span></li>`)
        .join("")}</ul></details>`
    : "";
  return `<header class="rec-h"><a class="back" href="${esc(back)}" aria-label="목록으로">←</a>${mark(r)}
<div class="title"><b>${esc(r.title)}</b><span class="meta">${esc(r.project)} · <span class="w s-${r.section}">${esc(r.word)}</span>${r.at ? ` · ${ago(now, r.at)}` : ""}</span></div></header>
<section class="thread" id="chat">${top}${waiting}${prs}${items(t.items)}<span id="end"></span></section>`;
}
