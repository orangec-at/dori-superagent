import { esc } from "./board-thread-html.ts";
import { ownerCounts, type Timeline, type TimelineItem, type TimelineState } from "./board-timeline.ts";

/** The 일정 tab: a phone gets the list with a short stage path; a desktop also gets the wide grid with stage cells. */
export const TIMELINE_STYLE = `.tlp,.tlt,.tlm{display:block;font-size:13px;overflow-wrap:anywhere}.tlp,.tlm{color:var(--muted)}.tlp b,.tlm b{color:var(--text)}
.tlo b{color:var(--text);font-weight:600}.tld{width:100%;max-width:1280px;margin:0 auto;padding:16px}.tld .sec{margin:6px 0 2px;font-size:16px;color:var(--text)}
.tld .note,.tld .agsum{margin:4px 0;padding:0}.tlg{margin:10px 0 24px;border-top:1px solid var(--line)}
.tlr{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(330px,2.4fr) minmax(180px,2fr) 84px 64px;gap:12px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line);font-size:13.5px;overflow-wrap:anywhere}
.tlr.tlh{color:var(--muted);font-size:12px;padding:6px 4px}.tlr small{display:block;color:var(--muted);font-size:12px}.tlr .ast{margin-left:6px}
.tlc{display:flex;gap:3px}.tlc i{flex:1;min-width:0;font-style:normal;font-size:11.5px;text-align:center;padding:3px 2px;border-radius:6px;background:var(--on);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tlc i.done{background:color-mix(in srgb,var(--blue) 24%,transparent);color:var(--text)}.tlc i.now{background:var(--blue);color:var(--bg);font-weight:700}
@media (max-width:1180px){.tlr{grid-template-columns:1fr;gap:4px}.tlr.tlh{display:none}}`;

const PILL: Record<TimelineState, string> = { 진행: "l-working", 대기: "l-idle", 보류: "l-unknown" };
const EMPTY = `<p class="note">일정 자료가 없어요. DORI_HOME/timelines/&lt;프로젝트&gt;.json 을 읽어요.</p>`;

/** http(s) links open; anything else is shown as text only. */
export const linkOf = (link: string): string =>
  /^https?:\/\//i.test(link)
    ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link.replace(/^https?:\/\//i, ""))}</a>`
    : esc(link);

const pill = (i: TimelineItem): string => `<span class="ast ${PILL[i.state]}">${i.state}</span>`;
const target = (i: TimelineItem): string => esc(i.target || "미정");

/** The short stage display: the stages so far, the current one in bold; 단계 미정 when the stage is unknown. */
export function stagePath(t: Timeline, i: TimelineItem): string {
  if (i.stage === null) return "<b>단계 미정</b>";
  const at = t.stages.indexOf(i.stage);
  return t.stages
    .slice(0, at + 1)
    .map((s, k) => (k === at ? `<b>${esc(s)}</b>` : esc(s)))
    .join(" → ");
}

function stageCells(t: Timeline, i: TimelineItem): string {
  const at = i.stage === null ? -1 : t.stages.indexOf(i.stage);
  const cells = t.stages.map((s, k) => `<i class="${k < at ? "done" : k === at ? "now" : ""}">${esc(s)}</i>`).join("");
  return `<span class="tlc" aria-label="단계 ${esc(i.stage ?? "미정")}">${cells}</span>${i.stage === null ? "<small>단계 미정</small>" : ""}`;
}

function head(t: Timeline): string {
  const who = ownerCounts(t)
    .map(([o, n]) => `<span class="tlo"><b>${esc(o)}</b> ${n}</span>`)
    .join(" · ");
  return (
    `<h3 class="sec"><span>${esc(t.title)}</span></h3><p class="note">${esc(t.updatedAt)} 기준${t.note ? ` · ${esc(t.note)}` : ""}</p>` +
    (who ? `<p class="agsum tlw">누구 차례: ${who}</p>` : "") +
    (t.dropped ? `<p class="note">형식이 맞지 않는 항목 ${t.dropped}개는 뺐어요.</p>` : "")
  );
}

function listRow(t: Timeline, i: TimelineItem): string {
  const meta = [`차례 <b>${esc(i.owner)}</b>`, `목표 ${target(i)}`, ...(i.size ? [`크기 ${esc(i.size)}`] : [])];
  return `<div class="row tli" data-item="${esc(i.id)}"><span class="rb"><span class="rt"><b>${esc(i.name)}</b>${pill(i)}</span>
<span class="tlp">${stagePath(t, i)}</span>${i.next ? `<span class="tlt">다음: ${esc(i.next)}</span>` : ""}<span class="tlm">${meta.join(" · ")}${i.link ? ` · ${linkOf(i.link)}` : ""}</span></span></div>`;
}

function gridRow(t: Timeline, i: TimelineItem): string {
  return `<div class="tlr" data-item="${esc(i.id)}"><span><b>${esc(i.name)}</b>${pill(i)}${i.size ? `<small>크기 ${esc(i.size)}</small>` : ""}</span>
<span>${stageCells(t, i)}</span><span>${esc(i.next)}${i.link ? `<small>${linkOf(i.link)}</small>` : ""}</span><span>${esc(i.owner)}</span><span>${target(i)}</span></div>`;
}

/** The list pane's body (all a phone sees): each project's heading and one row per feature. */
export function timelineTab(ts: Timeline[]): string {
  if (!ts.length) return EMPTY;
  return ts
    .map(
      (t) =>
        `<section class="tlx" data-project="${esc(t.project)}">${head(t)}${t.items.map((i) => listRow(t, i)).join("")}</section>`,
    )
    .join("");
}

/** The wide pane on a desktop: the same projects as a grid, the stages as cells filled up to the current one. */
export function timelinePane(ts: Timeline[]): string {
  if (!ts.length) return `<div class="tld">${EMPTY}</div>`;
  const th = `<div class="tlr tlh"><span>기능</span><span>단계</span><span>다음 할 일</span><span>차례</span><span>목표일</span></div>`;
  const body = ts
    .map(
      (t) =>
        `<section data-project="${esc(t.project)}">${head(t)}<div class="tlg">${th}${t.items.map((i) => gridRow(t, i)).join("")}</div></section>`,
    )
    .join("");
  return `<div class="tld">${body}</div>`;
}
