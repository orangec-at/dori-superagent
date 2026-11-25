import type { CoupasPost, CoupasRead, Posted } from "./board-coupas.ts";
import { esc, form } from "./board-thread-html.ts";
import { linkOf } from "./board-timeline-html.ts";

/** The 쿠파스 tab: a phone gets every card in the list; a desktop gets the cards in the wide pane, the list their heads. */
export const COUPAS_STYLE = `.cpc{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;margin:8px 4px 14px}
.cpc .rt b{white-space:normal}.cpc .ast{flex:none}.cpm{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.cpf{margin:10px 0 0}.cpf>small{color:var(--muted);font-size:12.5px}
.cpt{display:block;width:100%;margin:4px 0 6px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;resize:vertical;field-sizing:content;min-height:44px}
.cpc button,.cpbtn{min-height:44px;flex:1}.cpbtn{display:inline-flex;align-items:center;justify-content:center;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bubble);color:var(--text)}
.cpok{color:var(--green);font-weight:600;align-self:center;font-size:13.5px}.cpv{display:flex;margin:10px 0 0}.cpai{margin:4px 0 0}
.cpu{width:100%;min-height:44px;margin:10px 0 8px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:inherit}
.cps{margin:10px 0 0;color:var(--green);font-weight:600;font-size:13.5px;overflow-wrap:anywhere}.cpd{width:100%;max-width:760px;margin:0 auto;padding:16px}
@media (min-width:768px){.list .cpc>:not(.rt):not(.cpm){display:none}.list .cpc{padding:8px 12px;margin:6px 4px}}`;

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

/**
 * One text to copy. The parser drops a newline right after <textarea>, so one is always written there: the box's
 * value is then the text exactly, leading and trailing blanks and newlines included.
 */
const field = (label: string, text: string): string =>
  `<div class="cpf"><small>${label}</small><textarea class="cpt" readonly rows="${Math.min(30, text.split("\n").length)}" aria-label="${label}">\n${esc(text)}</textarea>` +
  `<div class="buttons"><button type="button" data-copy>${label} 복사</button><span class="cpok" role="status" hidden></span></div></div>`;

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
  const today = new Date(now + KST).toISOString().slice(0, 10);
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
  return head + (c.dropped ? `<p class="note">형식이 맞지 않는 글 ${c.dropped}개는 뺐어요.</p>` : "") + days.join("");
}

/** The wide pane on a desktop: the same cards, wider. */
export const coupasPane = (c: CoupasRead | null, now: number, token: string | null): string =>
  `<div class="cpd">${coupasTab(c, now, token, false)}</div>`;
