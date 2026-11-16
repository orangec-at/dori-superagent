import type { Hub } from "./board-hub.ts";
import {
  BADGE_WORD,
  type Badge,
  badgeOf,
  decisions,
  type HubEvent,
  type HubEventKind,
  nextSteps,
  type PrEntry,
  prGroups,
  timeline,
} from "./board-hub-state.ts";
import type { ProjectGroup } from "./board-state.ts";
import { ago, esc, prLabel } from "./board-thread-html.ts";

/** The project page's status card, its 7-day timeline and its PRs by state; and the badge a project row carries. */
export const HUB_STYLE = `.hub{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.hb-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hb-p{margin:0;font-weight:600;font-size:16px;line-height:1.4}
.bdg{font-size:12px;font-weight:700;padding:1px 9px;border-radius:999px;white-space:nowrap}
.b-blocked{background:color-mix(in srgb,var(--red) 22%,transparent);color:var(--red)}.b-turn{background:color-mix(in srgb,var(--needs) 20%,transparent);color:var(--needs)}
.b-active{background:color-mix(in srgb,var(--blue) 20%,transparent);color:var(--blue)}.b-rest{background:var(--on);color:var(--muted)}
.hub h4{margin:4px 0 0;font-size:13px;color:var(--muted)}.hub h4.needs{color:var(--needs)}
.dec{display:block;padding:7px 10px;border-radius:10px;color:var(--text);background:color-mix(in srgb,var(--needs) 10%,transparent);border:1px solid color-mix(in srgb,var(--needs) 40%,transparent)}
.dec .meta{display:block}.nx{margin:0;padding-left:20px}.nx li{overflow-wrap:anywhere}
.mts{display:flex;flex-wrap:wrap;gap:6px}.mt{background:var(--bg);border-radius:10px;padding:5px 10px;display:flex;flex-direction:column;min-width:0}
.mt b{font-size:15px}.mt b.unk{color:var(--muted);font-weight:500}
.ptl{list-style:none;margin:0;padding:0 6px}.ptl li{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:13.5px;min-width:0}
.ptl .ti{flex:none;width:20px;text-align:center}.ptl .tt{flex:none;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.ptl .tx{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.k-ready .ti,.k-merged .ti{color:var(--green)}.k-lost .ti{color:var(--red)}
.st{font-size:11.5px;padding:0 7px;border-radius:999px;white-space:nowrap}.st-OPEN{background:color-mix(in srgb,var(--blue) 20%,transparent);color:var(--blue)}
.st-MERGED{background:color-mix(in srgb,var(--green) 20%,transparent);color:var(--green)}.st-CLOSED,.st-x{background:var(--on);color:var(--muted)}
.pjm .st{margin-right:4px}.pjd ul.pjm{margin:2px 0;padding-left:20px}`;

const ICON: Record<HubEventKind, string> = {
  start: "▶",
  ready: "✋",
  done: "✓",
  lost: "⚠",
  backlog: "＋",
  merged: "⑂",
  talk: "💬",
};
const TIMELINE_SHOWN = 15;
const PR_WORD = { OPEN: "열림", MERGED: "병합", CLOSED: "닫힘" } as const;

export const badgeHtml = (b: Badge): string => `<span class="bdg b-${b}">${BADGE_WORD[b]}</span>`;

/** KST month/day and time: `11/16 18:25`. */
const kst = (at: number): string => {
  const d = new Date(at + 9 * 3_600_000).toISOString();
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${d.slice(11, 16)}`;
};

/** The status card: badge, purpose, numbers, what waits on the operator, then the next steps and the project's links. */
export function statusCard(g: ProjectGroup, hub: Hub | null, now: number, refs: string): string {
  const badge = badgeOf(g);
  const dec = decisions(g);
  const next = nextSteps(g);
  const metrics = hub?.metrics[g.name] ?? [];
  const mts = metrics.length
    ? `<div class="mts">${metrics.map((m) => `<span class="mt"><span class="meta">${esc(m.name)}</span>${m.value === null ? `<b class="unk">알 수 없음</b>` : `<b>${esc(m.value)}</b>`}</span>`).join("")}</div>`
    : "";
  const decs = dec.length
    ? `<h4 class="needs">재일 님이 결정할 것 ${dec.length}</h4>${dec.map((x) => `<a class="dec" href="${esc(x.href)}">${esc(x.title)}<span class="meta">${esc(x.sub)}</span></a>`).join("")}`
    : "";
  const steps = next.length
    ? `<h4>다음 할 일</h4><ol class="nx">${next.map((n) => `<li>${esc(n)}</li>`).join("")}</ol>`
    : "";
  const fresh = metrics.length && hub ? `<span class="meta">숫자 ${ago(now, hub.generatedAt)} 갱신</span>` : "";
  return `<section class="hub" aria-label="프로젝트 현황"><div class="hb-top">${badgeHtml(badge)}${fresh}</div>
${g.purpose ? `<p class="hb-p">${esc(g.purpose)}</p>` : ""}${mts}${decs}${steps}${refs}</section>`;
}

/** The last week, oldest first: lane starts, READYs, finishes, backlog additions, merged PRs and Discord talk. */
export function timelineHtml(g: ProjectGroup, hub: Hub | null, talk: HubEvent[], now: number): string {
  const ev = timeline(g, prGroups(g, hub, now).shown, talk).slice(-TIMELINE_SHOWN);
  if (!ev.length) return "";
  const rows = ev
    .map(
      (e) =>
        `<li class="k-${e.kind}"><span class="ti" aria-hidden="true">${ICON[e.kind]}</span><span class="tt">${kst(e.at)}</span><span class="tx" title="${esc(e.text)}">${esc(e.text)}</span></li>`,
    )
    .join("");
  return `<h3 class="sec"><span>진행 흐름 · 7일 <span>${ev.length}</span></span></h3><ol class="ptl">${rows}</ol>`;
}

const prRow = ({ p, l, state }: PrEntry): string =>
  `<li><span class="st ${state ? `st-${state}` : "st-x"}">${state ? PR_WORD[state] : "확인 전"}</span>${prLabel(p)} <span class="meta">${esc(p.repo ?? "")} · ${esc(l.key)}</span></li>`;

/** Open PRs and those merged this week; the rest folded under 지난 PR. */
export function prSection(g: ProjectGroup, hub: Hub | null, now: number): string {
  const { shown, past } = prGroups(g, hub, now);
  if (!shown.length && !past.length) return "";
  const head = `<h3 class="sec"><span>PR <span>${shown.length}</span></span></h3>`;
  const open = shown.length ? `<ul class="pjm">${shown.map(prRow).join("")}</ul>` : "";
  const old = past.length
    ? `<details class="sec"><summary>지난 PR ${past.length}개</summary><ul class="pjm">${past.map(prRow).join("")}</ul></details>`
    : "";
  return `${head}${open}${old}`;
}

/** A project row's line: the first decision, else the first next step, else its purpose with 진행 중인 일 없음. */
export function rowLine(g: ProjectGroup): string {
  const dec = decisions(g)[0];
  if (dec) return `결정: ${dec.title}`;
  const next = nextSteps(g)[0];
  if (next) return next;
  return `${g.purpose ? `${g.purpose} · ` : ""}${g.lanes.length + g.backlog.length ? "대기 중" : "진행 중인 일 없음"}`;
}
