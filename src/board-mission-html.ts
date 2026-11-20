import type { Actor, Mission, MissionCard, MissionStatus, Step } from "./board-mission-types.ts";
import { ago, esc } from "./board-thread-html.ts";

/**
 * The mission screens. Desktop: a map in the manner of Hide's mission plan (https://github.com/with-hide/hide, FSL-1.1-
 * ALv2; only the idea is followed, no code is taken): one column per participant with its avatar and machine, and each
 * hand-over an arrow from the giver's column to the taker's. A phone gets the same steps as a vertical timeline.
 */

const STEPS_SHOWN = 60;

export const MISSION_STYLE = `.av{flex:none;display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;font:600 12px/1 system-ui;
color:#0d1214;background:hsl(var(--h) 62% 68%)}img.av{object-fit:cover;background:var(--panel)}.av.sm{width:20px;height:20px;font-size:10.5px}.avs{display:inline-flex}.avs .av{margin-left:-6px;border:2px solid var(--list)}
.avs .av:first-child{margin-left:0}.st{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--panel);white-space:nowrap}
.st-run{color:var(--blue)}.st-ok{color:var(--green)}.st-stuck{color:var(--red)}.st-idle{color:var(--muted)}.st-needs{color:var(--needs)}
.rm{display:block;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcard{border:1px dashed var(--line);border-radius:14px;padding:10px 14px;background:var(--panel);font-size:14px;overflow-wrap:anywhere}
.mcard p{margin:2px 0}.mcard .k{color:var(--muted);display:inline-block;min-width:64px;font-size:12.5px}.mcard .mk{display:flex;gap:8px;align-items:center;font-weight:600}
.mneeds{display:block;color:var(--text)}.mneeds b{color:var(--needs)}
.map{overflow-x:auto;padding:4px 0 8px}.grid{display:grid;row-gap:10px;padding-bottom:8px}
.ll{background:linear-gradient(var(--line),var(--line)) center/2px 100% no-repeat}
.mh{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px 10px;background:var(--bg);text-align:center;color:var(--text)}
.mh b{font-size:13px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mh span{font-size:11px;color:var(--muted)}
.ms{position:relative;display:flex;justify-content:center;align-items:center;min-height:52px;padding-bottom:12px}
.ms .arr{position:absolute;left:calc(50% / var(--k));right:calc(50% / var(--k));bottom:4px;height:2px;background:var(--idle)}
.ms.d-r .arr::after,.ms.d-l .arr::before{content:"";position:absolute;top:-4px;border:5px solid transparent}
.ms.d-r .arr::after{right:-2px;border-left:8px solid var(--idle)}.ms.d-l .arr::before{left:-2px;border-right:8px solid var(--idle)}
.ms-needs .arr{background:var(--needs)}.ms-stuck .arr{background:var(--red)}.ms.d-self .arr{display:none}
.mt{position:relative;display:flex;gap:6px;align-items:flex-start;max-width:min(calc(100% - 12px),320px);padding:6px 10px;border:1px dashed var(--line);
border-radius:10px;background:var(--panel);color:var(--text);font-size:12.5px;line-height:1.4}
.mt span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ms-needs .mt{border:1px solid var(--needs);background:color-mix(in srgb,var(--needs) 14%,var(--panel))}.ms-stuck .mt{border-color:var(--red)}.ms-wait .mt{opacity:.7}
.tl{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--line)}.tl li{position:relative;margin:0 0 14px;padding-left:12px}
.tl li::before{content:"";position:absolute;left:-21px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--idle);border:2px solid var(--bg)}
.tl li.ts-ok::before{background:var(--green)}.tl li.ts-stuck::before{background:var(--red)}.tl li.ts-needs::before{background:var(--needs)}
.tl .tw{display:flex;gap:6px;align-items:center;font-size:13px}.tl .tw i{color:var(--muted);font-style:normal}.tl p{margin:3px 0 0;font-size:14px;overflow-wrap:anywhere}
.tl li.ts-needs p{color:var(--needs)}
@media (min-width:900px){.tl{display:none}}@media (max-width:899px){.map{display:none}}`;

const STATUS_CLASS: Record<MissionStatus, string> = { 대기: "idle", 진행: "run", 완료: "ok", 막힘: "stuck" };
export const statusPill = (s: MissionStatus): string => `<span class="st st-${STATUS_CLASS[s]}">${s}</span>`;

export const hue = (id: string): number => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
/** The participant's picture when it has one, else a letter circle in a colour of its own. */
export const avatar = (a: Actor, size = ""): string =>
  a.img
    ? `<img class="av${size ? ` ${size}` : ""}" src="${esc(a.img)}" alt="" title="${esc(a.label)}">`
    : `<span class="av${size ? ` ${size}` : ""}" style="--h:${hue(a.id)}" title="${esc(a.label)}">${esc([...a.label][0] ?? "?")}</span>`;

const isRow = (id: string): boolean => id === "lead" || /^(bot|lane|standing):/.test(id);
const rowHref = (id: string): string => `/?c=${encodeURIComponent(id)}`;
/** A mission opens at its top (#mtop): the page otherwise scrolls a record to its newest message. */
export const missionHref = (id: string): string => `/?m=${encodeURIComponent(id)}#mtop`;
const BOARD = "http://board.invalid";
/**
 * Only a web link or a board path becomes a link: lane evidence is free text. A path counts only when the browser's own
 * parsing keeps it on the board (`//x`, `/\x` and `/<tab>/x` are other hosts).
 */
const linked = (href: string | null, html: string): string => {
  if (href && /^https?:\/\//.test(href)) return `<a href="${esc(href)}" rel="noopener" target="_blank">${html}</a>`;
  return href?.startsWith("/") && URL.parse(href, BOARD)?.origin === BOARD
    ? `<a href="${esc(href)}">${html}</a>`
    : html;
};

/** The mission card at the top of a bot, standing lead or lane record. */
export function missionCard(c: MissionCard, cls = ""): string {
  const result = c.result ? `<p><span class="k">마지막 결과</span>${linked(c.href, esc(c.result))}</p>` : "";
  const flow = c.missionId ? `<p><a href="${esc(missionHref(c.missionId))}">협업 흐름 보기 →</a></p>` : "";
  return `<section class="mcard${cls ? ` ${cls}` : ""}"><p class="mk">미션 ${statusPill(c.status)}</p><p><span class="k">역할</span>${esc(c.role)}</p>
${c.note ? `<p><span class="k">규칙</span>${esc(c.note)}</p>` : ""}<p><span class="k">지금 미션</span>${esc(c.mission)}</p>${result}${flow}</section>`;
}

/** The mission line under a row in the list. */
export const rowMission = (c: MissionCard | undefined): string =>
  c ? `<span class="rm">🎯 ${esc(c.status)} · ${esc(c.mission)}</span>` : "";

function stepLabel(s: Step, by: Map<string, Actor>, now: number): string {
  return `${avatar(by.get(s.from)!, "sm")}<span>${linked(s.href, esc(s.what))} <span class="meta">${ago(now, s.at)}</span></span>`;
}

function map(m: Mission, steps: Step[], by: Map<string, Actor>, now: number): string {
  const col = new Map(m.actors.map((a, i) => [a.id, i]));
  const heads = m.actors
    .map(
      (a, i) =>
        `<div class="mh" style="grid-column:${i + 1};grid-row:1">${linked(isRow(a.id) ? rowHref(a.id) : null, avatar(a))}<b>${esc(a.label)}</b><span>${esc(a.sub)}</span></div>`,
    )
    .join("");
  const lines = m.actors
    .map((_, i) => `<div class="ll" style="grid-column:${i + 1};grid-row:1/${steps.length + 2}"></div>`)
    .join("");
  const cells = steps
    .map((s, r) => {
      const [a, b] = [col.get(s.from)!, col.get(s.to)!];
      const dir = a === b ? "self" : a < b ? "r" : "l";
      return `<div class="ms ms-${s.state} d-${dir}" style="--k:${Math.abs(a - b) + 1};grid-column:${Math.min(a, b) + 1}/${Math.max(a, b) + 2};grid-row:${r + 2}"><span class="arr"></span><span class="mt">${stepLabel(s, by, now)}</span></div>`;
    })
    .join("");
  return `<div class="map"><div class="grid" style="grid-template-columns:repeat(${m.actors.length},minmax(120px,1fr))">${lines}${heads}${cells}</div></div>`;
}

function timeline(steps: Step[], by: Map<string, Actor>, now: number): string {
  const li = steps.map((s) => {
    const [from, to] = [by.get(s.from)!, by.get(s.to)!];
    const who =
      s.from === s.to
        ? `${avatar(from, "sm")} <b>${esc(from.label)}</b>`
        : `${avatar(from, "sm")} <b>${esc(from.label)}</b><i>→</i>${avatar(to, "sm")} <b>${esc(to.label)}</b>`;
    return `<li class="ts-${s.state}"><div class="tw">${who}<span class="meta">${ago(now, s.at)}</span></div><p>${linked(s.href, esc(s.what))}</p></li>`;
  });
  return `<ol class="tl">${li.join("")}</ol>`;
}

/** A mission's screen: who took part, what waits on the operator, then the hand-overs as a map (desktop) or timeline (phone). */
export function missionPane(m: Mission, now: number, back: string): string {
  const by = new Map(m.actors.map((a) => [a.id, a]));
  const steps = m.steps.slice(-STEPS_SHOWN);
  const cut = m.steps.length - steps.length;
  const needs = m.needs
    ? `<a class="ask mneeds" href="${esc(rowHref(m.needs))}"><b>재일 님 차례</b> · ${esc(by.get(m.needs)?.label ?? m.needs)} 머지 승인 확인 →</a>`
    : "";
  return `<header class="rec-h" id="mtop"><a class="back" href="${esc(back)}" aria-label="목록으로">←</a><span class="avs">${m.actors.map((a) => avatar(a, "sm")).join("")}</span>
<div class="title"><b>${esc(m.title)}</b><span class="meta">${statusPill(m.status)} 참여 ${m.actors.length} · 단계 ${m.steps.length} · ${ago(now, m.at)}</span></div></header>
<section class="thread" id="chat">${needs}${cut ? `<p class="note">앞의 ${cut}단계는 생략했어요.</p>` : ""}${map(m, steps, by, now)}${timeline(steps, by, now)}<span id="end"></span></section>`;
}
