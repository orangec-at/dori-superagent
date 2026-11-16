import { avatar, missionCard, missionHref, statusPill } from "./board-mission-html.ts";
import type { Mission, MissionCard, Routine } from "./board-mission-types.ts";
import type { Row } from "./board-status.ts";
import { ago, esc, mark } from "./board-thread-html.ts";

/**
 * The bot-chat layout: a phone shows the list or the conversation; a tablet (768px+) the list beside the conversation,
 * the detail pane a panel its button opens; a desktop (1024px+) all three. The avatar strip tops the list everywhere,
 * and a wide screen shows the conversation as avatar bubbles with long paths and ids folded. The phone's look is kept:
 * every wide-screen rule sits in a min-width query.
 */

export const DETAIL_STYLE = `.av.lg{width:52px;height:52px;font-size:20px}.av.xl{width:64px;height:64px;font-size:26px}
.ra{position:relative;flex:none;margin-top:1px}.ra .ic{position:absolute;right:-4px;bottom:-4px;width:13px;height:13px;margin:0;font-size:9px}
.strip{display:flex;gap:10px;overflow-x:auto;padding:2px 8px 12px;scrollbar-width:none}.sa{position:relative;flex:none;width:62px;display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--text);font-size:12px}
.sa>span:last-child{max-width:62px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sa .ic{position:absolute;top:38px;right:4px;margin:0}
.detail{display:none}.dh{display:flex;flex-direction:column;align-items:center;gap:4px;margin:6px 0 14px;text-align:center}.dh b{font-size:17px}
.detail h4{margin:16px 2px 6px;font-size:13px;color:var(--muted);font-weight:600}.routines{list-style:none;margin:0;padding:0}
.routines li{display:flex;gap:10px;padding:7px 2px;border-bottom:1px solid var(--line)}.routines .ck{color:var(--green)}.routines .off{color:var(--muted)}
.routines b{display:block;font-weight:600;font-size:14px}.dm{display:flex;gap:6px;align-items:baseline;padding:6px 2px;color:var(--text);font-size:13.5px}
.dm span.t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who{display:flex;gap:10px;align-items:center;padding:6px 2px;color:var(--text)}
.mav,.hav,.ls,.dt,.dtb,.dts{display:none}
@media (min-width:768px){.tab{white-space:nowrap}.list .row{border-radius:12px;padding:10px 12px}.list .strip{padding:4px 8px 14px}
.rec-h{padding:12px 20px}.rec-h>.ic{display:none}.hav{display:block;flex:none}.title b{font-size:16px}
.thread{padding:20px 24px 8px;gap:12px}.mcard.inline{display:none}.lf{display:none}.ls{display:inline}.lt{border-bottom:1px dotted var(--idle);cursor:help}
.msg.them{flex-direction:row;gap:10px;align-items:flex-start}.mav{display:block;flex:none;margin-top:2px}
.mb{min-width:0;max-width:85%;display:flex;flex-direction:column;align-items:flex-start}.mb>.text{background:var(--bubble);border-radius:6px 18px 18px 18px;padding:9px 14px}
.mb>.ev,.mb>.meta{margin-left:6px}.thread>.work{margin-left:36px;align-self:flex-start;max-width:calc(100% - 36px)}
.thread>.work summary{display:inline-block;padding:3px 12px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12.5px}
.thread>.note{align-self:center;text-align:center;max-width:90%;margin:0;padding:4px 14px;border-radius:999px;background:var(--panel);font-size:12.5px}
.detail{padding:20px 16px 32px;background:var(--list);overflow-y:auto}.detail .mcard{border-style:solid;border-radius:16px}}
@media (min-width:768px) and (max-width:1023px){.dt{display:block;position:fixed;width:1px;height:1px;opacity:0;pointer-events:none}.dtb{display:block;position:fixed;top:12px;right:16px;z-index:7;padding:6px 14px;border-radius:999px;
background:var(--panel);border:1px solid var(--line);font-size:13.5px;font-weight:600;cursor:pointer}.dt:focus-visible+.dtb{outline:2px solid var(--link);outline-offset:2px}
.rec-h{padding-right:96px}.detail{display:block;position:fixed;top:0;right:0;bottom:0;z-index:9;width:min(340px,88vw);border-left:1px solid var(--line);
transform:translateX(100%);visibility:hidden;transition:transform .2s,visibility .2s}.dt:checked~.detail{transform:none;visibility:visible}
.dt:checked~.dts{display:block;position:fixed;inset:0;z-index:8;background:rgb(0 0 0/.35)}}
@media (min-width:1024px){.app{grid-template-columns:320px minmax(0,1fr) 300px}.detail{display:block;position:sticky;top:0;align-self:start;height:100dvh;
border-left:1px solid var(--line)}}`;

const LEAD_CARD: MissionCard = {
  role: "총괄 · 재일 님과 대화하고 lane·봇에 일을 나눠요. 병합은 재일 님 승인 뒤에만",
  note: null,
  mission: "아침 배정과 열린 lane을 끝까지 챙기기",
  status: "진행",
  result: null,
  href: null,
  missionId: null,
};

type Imgs = Record<string, string>;
const actorOf = (r: Pick<Row, "id" | "title">, imgs: Imgs) => {
  const img = imgs[r.id];
  return img ? { id: r.id, label: r.title, sub: "", img } : { id: r.id, label: r.title, sub: "" };
};

/** A row's avatar alone: a record's header and the answers in it. */
export const rowFace = (r: Row, imgs: Imgs): string => avatar(actorOf(r, imgs));

/** A list row's avatar with its status mark as a badge; an ask keeps the plain mark. */
export const rowAvatar = (r: Row, imgs: Imgs): string =>
  r.kind === "ask" ? mark(r) : `<span class="ra">${avatar(actorOf(r, imgs))}${mark(r)}</span>`;

/** The row of big bot avatars above the list, as in a bot-chat app. */
export function strip(rows: Row[], href: (id: string) => string, imgs: Imgs): string {
  const who = rows.filter((r) => r.kind === "lead" || r.kind === "bot" || r.kind === "standing");
  return `<nav class="strip" aria-label="봇">${who
    .map(
      (r) =>
        `<a class="sa" href="${esc(href(r.id))}">${avatar(actorOf(r, imgs), "lg")}${mark(r)}<span>${esc(r.title)}</span></a>`,
    )
    .join("")}</nav>`;
}

const routineList = (list: Routine[], now: number): string =>
  `<h4>루틴</h4><ul class="routines">${list
    .map(
      (r) =>
        `<li><span class="${r.last ? "ck" : "off"}">${r.last ? "✓" : "○"}</span><div><b>${esc(r.name)}</b><span class="meta">${esc(r.when)}${r.last ? ` · 마지막 ${ago(now, r.last)}` : ""}</span></div></li>`,
    )
    .join("")}</ul>`;

/** The detail pane of a row: who it is, its mission card, the routines it is part of and the missions it took part in. */
export function detailPane(
  r: Row,
  card: MissionCard | undefined,
  routines: Routine[],
  missions: Mission[],
  now: number,
  imgs: Imgs,
): string {
  const mine = missions.filter((m) => m.actors.some((a) => a.id === r.id)).slice(0, 6);
  const list = mine.length
    ? `<h4>참여한 미션</h4>${mine
        .map(
          (m) =>
            `<a class="dm" href="${esc(missionHref(m.id))}">${statusPill(m.status)}<span class="t">${esc(m.title)}</span><span class="meta">${ago(now, m.at)}</span></a>`,
        )
        .join("")}`
    : "";
  const own = routines.filter((x) => x.for.includes(r.kind));
  return `<aside class="detail" aria-label="상세"><div class="dh">${avatar(actorOf(r, imgs), "xl")}<b>${esc(r.title)}</b><span class="meta">${esc(r.project)}</span></div>
${missionCard(card ?? (r.kind === "lead" ? LEAD_CARD : { ...LEAD_CARD, role: r.project, mission: r.line, status: "대기" }))}${own.length ? routineList(own, now) : ""}${list}</aside>`;
}

/** The detail pane of a mission: everyone who took part, each linked to its record. */
export function missionDetail(m: Mission): string {
  const who = m.actors
    .map((a) => {
      const inner = `${avatar(a)}<span><b>${esc(a.label)}</b><br><span class="meta">${esc(a.sub)}</span></span>`;
      return /^(lead|bot:|lane:|standing:)/.test(a.id)
        ? `<a class="who" href="/?c=${encodeURIComponent(a.id)}">${inner}</a>`
        : `<div class="who">${inner}</div>`;
    })
    .join("");
  return `<aside class="detail" aria-label="참여"><div class="dh"><b>${esc(m.title)}</b>${statusPill(m.status)}</div><h4>참여 ${m.actors.length}</h4>${who}</aside>`;
}
