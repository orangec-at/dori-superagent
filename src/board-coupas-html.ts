import type { CoupasPost, CoupasRead, Posted } from "./board-coupas.ts";
import { esc, form } from "./board-thread-html.ts";
import { linkOf } from "./board-timeline-html.ts";

/** The 쿠파스 tab: a phone gets every card in the list; a desktop gets the cards in the wide pane, the list their heads. */
export const COUPAS_STYLE = `.cpc{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;margin:8px 4px 14px}
.cpc .rt b{white-space:normal}.cpc .ast{flex:none}.cpm{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.cpf{margin:10px 0 0}.cpf>small{color:var(--muted);font-size:12.5px}
.cpt{display:block;width:100%;margin:4px 0 6px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;resize:vertical;field-sizing:content;min-height:44px}
.cpc button,.cpbtn{min-height:44px;flex:1}.cpbtn{display:inline-flex;align-items:center;justify-content:center;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bubble);color:var(--text)}
.cpc button[data-copy]{display:inline-flex;align-items:center;justify-content:center;gap:6px;overflow:hidden}
.cpi{position:relative;width:18px;height:18px;flex:none}.cpi svg{position:absolute;inset:0;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.cpi .ok{color:var(--green);stroke-width:2.4;opacity:0;transform:scale(.4)}.cpr{display:block;height:20px;overflow:hidden}.cpw{display:flex;flex-direction:column}
.cpw b{display:block;height:20px;line-height:20px;font-weight:inherit;white-space:nowrap}.cpw b+b{color:var(--green);font-weight:600}
.cpok{color:var(--green);font-weight:600;align-self:center;font-size:13.5px}.cpv{display:flex;margin:10px 0 0}.cpai{margin:4px 0 0}
.cpu{width:100%;min-height:44px;margin:10px 0 8px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:inherit}
.cps{margin:10px 0 0;color:var(--green);font-weight:600;font-size:13.5px;overflow-wrap:anywhere}.cpd{width:100%;max-width:760px;margin:0 auto;padding:16px}
.cpb{margin:8px 4px 18px}.cpb>.sec{margin:6px 6px 6px}.cpbd>summary{cursor:pointer;color:var(--muted);font-size:13.5px;padding:8px 6px;min-height:44px;display:flex;align-items:center}
.cpbr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;margin:0 0 6px}
.cpbr.today{border:2px solid var(--blue);background:color-mix(in srgb,var(--blue) 8%,var(--panel))}.cpbr.late{border-color:var(--needs)}.cpbr.done .cpbt b{color:var(--muted)}
.cpbt{min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;font-size:14px}.cpbt time{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}.cpbt b{overflow-wrap:anywhere}
.cpl{font-size:12px;font-weight:600;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--needs) 18%,transparent);color:var(--needs)}
.cpbf fieldset{border:0;margin:0;padding:0}.cpck{min-height:44px;min-width:64px;padding:6px 10px;border-radius:10px;border:1px solid var(--line);background:var(--bubble);color:var(--text);font:inherit;font-size:13.5px}
.cpck.on{color:var(--green);font-weight:600;border-color:color-mix(in srgb,var(--green) 50%,transparent)}.cpck small{font-weight:400;font-size:11.5px}
.cpbc{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.cpbc .cpf{margin:0;position:relative;min-width:0}.cpbc .cpbtn{min-height:44px;padding:6px;font-size:13.5px}
.cpbc .cpt{position:absolute;inset:0;width:100%;height:100%;min-height:0;margin:0;padding:0;border:0;opacity:0;pointer-events:none;resize:none}
.cpbc button[data-copy]{position:relative;width:100%;min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:6px 4px;overflow:hidden;font-size:13.5px}
.cpbc .cpok{position:absolute;top:100%;left:0;z-index:1;font-size:11.5px;white-space:nowrap;background:var(--panel);border-radius:6px;padding:1px 4px}.cpbr .fnote{grid-column:1/-1;margin:0}
@media (min-width:768px){.list .cpc>:not(.rt):not(.cpm){display:none}.list .cpc{padding:8px 12px;margin:6px 4px}.list .cpb{display:none}}`;

const EMPTY = `<p class="note">아직 올릴 글이 없어요.</p>`;
const DAY = 86_400_000;
const KST = 9 * 3_600_000;

/** The KST clock of an ISO time ("11-24 19:22"), or the text as written when it is not a time. */
const kstOf = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + KST).toISOString().slice(5, 16).replace("T", " ");
};

/** Today first, then the days to come, then the past ones newest first. */
export function dayOrder(dates: string[], today: string): string[] {
  const days = [...new Set(dates)];
  return [
    ...days.filter((d) => d === today),
    ...days.filter((d) => d > today).sort(),
    ...days.filter((d) => d < today).sort((a, b) => (a < b ? 1 : -1)),
  ];
}

/** The copy icon and the check that takes its place once copied (board.js moves them). */
const COPY_ICON =
  `<span class="cpi" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="11" rx="3"/>` +
  `<path d="M15.5 8.5V7a2.5 2.5 0 0 0-2.5-2.5H7A2.5 2.5 0 0 0 4.5 7v6A2.5 2.5 0 0 0 7 15.5h1.5"/></svg>` +
  `<svg class="ok" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>`;

/**
 * One text to copy. The parser drops a newline right after <textarea>, so one is always written there: the box's
 * value is then the text exactly, leading and trailing blanks and newlines included.
 */
const field = (label: string, text: string): string =>
  `<div class="cpf"><small>${label}</small><textarea class="cpt" readonly rows="${Math.min(30, text.split("\n").length)}" aria-label="${label}">\n${esc(text)}</textarea>` +
  `<div class="buttons"><button type="button" data-copy aria-label="${label} 복사">${COPY_ICON}` +
  `<span class="cpr" aria-hidden="true"><span class="cpw"><b>${label} 복사</b><b>복사됨</b></span></span></button><span class="cpok" role="status" hidden></span></div></div>`;

/** The first Coupang link in a post's first reply, or "" for a post without a product. */
export const linkIn = (reply: string): string => reply.match(/https:\/\/link\.coupang\.com\/[^\s<>"'(),]+/)?.[0] ?? "";

/** A copy button of the upload table: the same box, button and board.js code as a card's field, the box kept out of sight. */
const copyCell = (label: string, short: string, text: string): string =>
  `<div class="cpf"><textarea class="cpt" readonly tabindex="-1" aria-hidden="true">\n${esc(text)}</textarea>` +
  `<span class="cpq"><button type="button" data-copy aria-label="${label} 복사">${COPY_ICON}` +
  `<span class="cpr" aria-hidden="true"><span class="cpw"><b>${short}</b><b>복사됨</b></span></span></button><span class="cpok" role="status" hidden></span></span></div>`;
const NO_CELL = `<span></span>`;

/**
 * One post's line in the upload table: when, title, the copy buttons, its video and the upload check, which is the
 * card's POST /coupas (`posted`, then `undo`) as it is. `today` marks it; a past post not yet up is 밀림.
 */
function row(p: CoupasPost, done: Posted | undefined, token: string | null, today: string): string {
  const late = !done && p.date < today;
  const link = linkIn(p.reply);
  const check = done
    ? `<button class="cpck on" name="action" value="undo" aria-label="${esc(p.title)} 업로드 체크 풀기">✓ <small>${esc(kstOf(done.postedAt))}</small></button>`
    : `<button class="cpck" name="action" value="posted" aria-label="${esc(p.title)} 올렸음">올림</button>`;
  return (
    `<div class="cpbr${p.date === today ? " today" : ""}${late ? " late" : ""}${done ? " done" : ""}" data-post="${esc(p.id)}">` +
    `<span class="cpbt"><time>${esc(p.date.slice(5))} ${esc(p.time)}</time>${late ? `<span class="cpl">밀림</span>` : ""}<b>${esc(p.title)}</b></span>` +
    form("/coupas", token, `<input type="hidden" name="id" value="${esc(p.id)}">${check}`, "cpbf") +
    `<div class="cpbc">${link ? copyCell("링크", "링크", link) : NO_CELL}${copyCell("글", "글", p.body)}` +
    `${p.reply ? copyCell("첫 답글", "답글", p.reply) : NO_CELL}` +
    `${p.video ? `<a class="cpbtn" href="${esc(`/coupas/video?id=${encodeURIComponent(p.id)}`)}" download>영상</a>` : NO_CELL}</div></div>`
  );
}

const todayOf = (now: number): string => new Date(now + KST).toISOString().slice(0, 10);

/** One post's upload-table line as posted.json says now, or null when posts.json no longer has it. */
export function coupasRow(c: CoupasRead | null, id: string, token: string | null, now: number): string | null {
  const p = c?.posts.find((x) => x.id === id);
  return c && p ? row(p, c.posted[id], token, todayOf(now)) : null;
}

/** The upload table: a line per post by date and time; past days that are all up fold away at its top. */
function uploadTable(c: CoupasRead, token: string | null, today: string): string {
  const at = (p: CoupasPost): string => `${p.date} ${p.time}`;
  const posts = [...c.posts].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  const allUp = (d: string): boolean => d < today && posts.every((p) => p.date !== d || c.posted[p.id]);
  const folded = posts.filter((p) => allUp(p.date));
  const open = posts.filter((p) => !allUp(p.date));
  const late = open.filter((p) => p.date < today && !c.posted[p.id]).length;
  const line = (p: CoupasPost): string => row(p, c.posted[p.id], token, today);
  return (
    `<section class="cpb" aria-label="업로드 표"><h3 class="sec"><span${late ? ` class="needs"` : ""}>업로드 표${late ? ` <span>밀림 ${late}</span>` : ""}</span></h3>` +
    (folded.length
      ? `<details class="cpbd"><summary>지난 글 ${folded.length}개 · 다 올렸음</summary>${folded.map(line).join("")}</details>`
      : "") +
    `${open.map(line).join("")}</section>`
  );
}

function status(p: CoupasPost, done: Posted | undefined, token: string | null): string {
  const url = (value: string) =>
    `<input class="cpu" name="url" type="url" maxlength="500" value="${esc(value)}" placeholder="글 주소 (선택)" aria-label="글 주소">`;
  const body = done
    ? `<p class="cps">올렸음 · ${esc(kstOf(done.postedAt))}${done.url ? ` · ${linkOf(done.url)}` : ""}</p>${url(done.url)}` +
      `<div class="buttons"><button name="action" value="posted">주소 저장</button><button name="action" value="undo">되돌리기</button></div>`
    : `${url("")}<div class="buttons"><button class="primary" name="action" value="posted">올렸음</button></div>`;
  return form("/coupas", token, `<input type="hidden" name="id" value="${esc(p.id)}">${body}`);
}

function card(p: CoupasPost, done: Posted | undefined, token: string | null, anchor: boolean): string {
  const video = p.video
    ? `<p class="cpv"><a class="cpbtn" href="${esc(`/coupas/video?id=${encodeURIComponent(p.id)}`)}" download>영상 받기</a></p>`
    : "";
  const ai = p.video || p.aiLabel ? `<p class="note cpai">AI 정보 라벨을 켜 주세요.</p>` : "";
  return (
    `<article class="cpc"${anchor ? ` id="cp-${esc(p.id)}"` : ""} data-post="${esc(p.id)}"><span class="rt"><b>${esc(p.time)} ${esc(p.title)}</b>` +
    `<span class="ast ${done ? "l-working" : "l-idle"}">${done ? "올렸음" : "아직"}</span></span>` +
    `${p.product ? `<span class="cpm">${esc(p.product)}</span>` : ""}${field("본문", p.body)}${p.reply ? field("첫 답글", p.reply) : ""}` +
    `${video}${ai}${status(p, done, token)}</article>`
  );
}

/** One post's card as the wide pane shows it (no anchor id), or null when posts.json no longer has it. */
export function coupasCard(c: CoupasRead | null, id: string, token: string | null): string | null {
  const p = c?.posts.find((x) => x.id === id);
  return c && p ? card(p, c.posted[id], token, false) : null;
}

/** The cards grouped by day, today first, each day by time. `anchor`: the cards carry the ids a write returns to. */
export function coupasTab(c: CoupasRead | null, now: number, token: string | null, anchor = true): string {
  if (!c?.posts.length) return EMPTY;
  const today = todayOf(now);
  const days = dayOrder(
    c.posts.map((p) => p.date),
    today,
  ).map((d) => {
    const list = c.posts.filter((p) => p.date === d).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const left = list.filter((p) => !c.posted[p.id]).length;
    const label =
      d === today
        ? `오늘 · ${esc(d)}`
        : d === new Date(now + KST + DAY).toISOString().slice(0, 10)
          ? `내일 · ${esc(d)}`
          : esc(d);
    return (
      `<section class="cpx" data-day="${esc(d)}"><h3 class="sec"><span class="${d === today && left ? "needs" : ""}">${label} <span>${left ? `아직 ${left}` : "다 올렸음"}</span></span></h3>` +
      list.map((p) => card(p, c.posted[p.id], token, anchor)).join("") +
      `</section>`
    );
  });
  const head = `<p class="note">${c.updatedAt ? `${esc(kstOf(c.updatedAt))} 기준 · ` : ""}복사해서 Threads 앱에 직접 올려요.</p>`;
  return (
    head +
    (c.dropped ? `<p class="note">형식이 맞지 않는 글 ${c.dropped}개는 뺐어요.</p>` : "") +
    uploadTable(c, token, today) +
    days.join("")
  );
}

/** The wide pane on a desktop: the same cards, wider. */
export const coupasPane = (c: CoupasRead | null, now: number, token: string | null): string =>
  `<div class="cpd">${coupasTab(c, now, token, false)}</div>`;
