import type { BoardState, ProjectGroup } from "./board-state.ts";
import {
  COLUMNS,
  daysUntil,
  FILTERS,
  filterTasks,
  type Milestone,
  nextDue,
  progressOf,
  type Task,
  type TaskFilter,
} from "./board-tasks.ts";
import { hrefOf, type View } from "./board-list-html.ts";
import { ago, esc, form } from "./board-thread-html.ts";

/**
 * The project page's work: who runs it and the next due date, milestones with progress, and the tasks in four columns
 * (one under another on a phone) with filter chips. A writer also gets forms that change the backlog through POST
 * /backlog: add a task, change an open item's priority, answer its decision or drop it.
 */
export const TASKS_STYLE = `.ovf{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;font-size:13.5px}.ovf div{display:flex;gap:6px}.ovf dt{color:var(--muted)}.ovf dd{margin:0}
.ovf .late{color:var(--red)}.pmss{display:flex;flex-direction:column;gap:8px;padding:0 6px}.pms{display:flex;flex-direction:column;gap:2px}.pms-h{display:flex;gap:8px;align-items:baseline}
.pms-h b{flex:1;min-width:0;font-size:14px}.pms progress{width:100%;height:8px;accent-color:var(--green)}.kc details summary{cursor:pointer;color:var(--muted);font-size:13px;padding:2px 4px}
.kc details[open]{display:flex;flex-direction:column;gap:6px}
.app.pj .pjd{max-width:1280px}.kb{display:grid;gap:10px;grid-template-columns:minmax(0,1fr)}
.kc{background:var(--list);border:1px solid var(--line);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}
.kc h4{margin:2px 4px;font-size:13px;color:var(--muted);display:flex;justify-content:space-between}
.tk{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:7px 9px;display:flex;flex-direction:column;gap:3px;min-width:0}
.tk.blk{border-color:color-mix(in srgb,var(--red) 60%,transparent)}.tk.mine{border-color:color-mix(in srgb,var(--needs) 60%,transparent)}
.tk b{font-weight:600;font-size:14px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.tk a{color:inherit}.tk .meta{display:flex;gap:6px;flex-wrap:wrap}
.tk .q{font-size:13px;color:var(--needs);font-weight:500;margin:0}.tk .fl{color:var(--red);font-weight:600}
.tka{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.tka form{display:contents}.tka fieldset{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tka select,.tka input,.tka textarea,.add input,.add select,.add textarea{font:inherit;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:5px 8px}
.tka button,.add button{min-height:32px;padding:4px 10px;font-size:13px}.tka details{width:100%}.tka textarea,.add textarea,.add input[name=title]{width:100%}
.add summary{cursor:pointer;color:var(--link);font-size:13.5px;padding:2px 4px}.add fieldset{display:flex;flex-direction:column;gap:6px;padding-top:6px}
@media (min-width:768px){.kb{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:1280px){.kb{grid-template-columns:repeat(4,minmax(0,1fr))}}`;

const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** A long 완료 column shows its newest cards and folds the rest. */
const DONE_SHOWN = 6;
const KIND_WORD: Record<Task["kind"], string> = { item: "백로그", lane: "lane", bot: "봇" };

const kstDay = (due: string): string => `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}`;
const dday = (n: number): string => (n === 0 ? "D-day" : n > 0 ? `D-${n}` : `${-n}일 지남`);

/** 담당 (the standing lead, the open lanes, the bots) and the next due milestone, for the status card. */
export function overviewFacts(g: ProjectGroup, s: Pick<BoardState, "standing">, tasks: Task[], now: number): string {
  const lead = s.standing.find((c) => c.domain === g.name);
  const owners = [
    lead ? `lead ${lead.domain}${lead.on ? "" : " (꺼짐)"}` : "lead 도리도라",
    g.lanes.length ? `lane ${g.lanes.length}` : "",
    g.bots.length ? `봇 ${g.bots.join(", ")}` : "",
  ].filter(Boolean);
  const due = nextDue(g.milestones, tasks);
  const left = due?.due ? daysUntil(due.due, now) : null;
  const dueHtml =
    due?.due && left !== null
      ? `<span class="${left < 0 ? "late" : ""}">${esc(kstDay(due.due))} ${esc(due.name)} · ${dday(left)}</span>`
      : "없음";
  const open = tasks.filter((t) => t.col !== "done").length;
  return `<dl class="ovf"><div><dt>담당</dt><dd>${esc(owners.join(" · "))}</dd></div><div><dt>다음 마감</dt><dd>${dueHtml}</dd></div><div><dt>남은 작업</dt><dd>${open}</dd></div></dl>`;
}

/** Each milestone with its due date and a progress bar of its keys done. */
export function milestonesHtml(ms: Milestone[], tasks: Task[], now: number): string {
  if (!ms.length) return "";
  const rows = ms.map((m) => {
    const { done, total } = progressOf(m, tasks);
    const due = m.due ? `${kstDay(m.due)} · ${done === total ? "완료" : dday(daysUntil(m.due, now))}` : "마감 없음";
    return `<div class="pms"><div class="pms-h"><b>${esc(m.name)}</b><span class="meta">${esc(due)} · ${done}/${total}</span></div><progress max="${Math.max(total, 1)}" value="${done}" aria-label="${esc(m.name)} 진행률"></progress></div>`;
  });
  return `<h3 class="sec"><span>마일스톤 <span>${ms.length}</span></span></h3><div class="pmss">${rows.join("")}</div>`;
}

const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const prioritySelect = (now: number | null): string =>
  `<select name="priority" aria-label="우선순위">${PRIORITIES.map((p) => `<option value="${p}"${p === (now ?? 5) ? " selected" : ""}>p${p}</option>`).join("")}</select>`;

function taskActions(t: Task, project: string, token: string): string {
  const base = `${hidden("p", project)}${hidden("id", t.id)}`;
  const decide = t.decision
    ? `<details><summary class="meta">결정 답하기</summary>${form("/backlog", token, `${base}${hidden("action", "decide")}<textarea name="text" rows="2" required maxlength="2000" aria-label="결정 답"></textarea><button>답 보내기</button>`)}</details>`
    : "";
  return `<div class="tka">${form("/backlog", token, `${base}${hidden("action", "priority")}${prioritySelect(t.priority)}<button>우선순위 변경</button>`)}${form("/backlog", token, `${base}${hidden("action", "drop")}<button>드롭</button>`)}${decide}</div>`;
}

/** One task's card; board-inline.ts sends it alone after a background /backlog edit. */
export function taskCard(t: Task, project: string, token: string | null, now: number): string {
  const title = t.href ? `<a href="${esc(t.href)}">${esc(t.title)}</a>` : esc(t.title);
  const meta = [
    t.blocked ? `<span class="fl">막힘</span>` : "",
    t.priority !== null ? `<span>p${t.priority}</span>` : "",
    `<span>${KIND_WORD[t.kind]}</span>`,
    ...t.prs.map((n) => `<span class="pr">⑂ #${n}</span>`),
    t.at ? `<span>${ago(now, t.at)}</span>` : "",
  ].join("");
  const q = t.decision ? `<p class="q">결정 필요: ${esc(t.decision)}</p>` : "";
  const acts = token && t.editable ? taskActions(t, project, token) : "";
  return `<div class="tk${t.blocked ? " blk" : t.mine ? " mine" : ""}" id="t-${esc(t.id.replace(/[^a-z0-9-]/g, "-"))}"><b>${title}</b><span class="meta">${meta}</span>${q}${acts}</div>`;
}

function addForm(project: string, token: string): string {
  return `<details class="add"><summary>＋ 작업 추가</summary>${form(
    "/backlog",
    token,
    `${hidden("p", project)}${hidden("action", "add")}<input name="title" required maxlength="200" placeholder="할 일 제목" aria-label="작업 제목">${prioritySelect(null)}<textarea name="text" rows="3" maxlength="2000" placeholder="설명 (선택)" aria-label="작업 설명"></textarea><button class="primary">백로그에 추가</button>`,
  )}</details>`;
}

/** Filter chips and the four columns; an empty column says so, and 할 일 starts with the add form for a writer. */
export function taskBoard(g: ProjectGroup, tasks: Task[], v: View, token: string | null, now: number): string {
  const f: TaskFilter = v.k ?? "all";
  const shown = filterTasks(tasks, f);
  const chips = `<nav class="chips">${FILTERS.map(([k, label]) => `<a class="chip${f === k ? " on" : ""}${k === "mine" || k === "blocked" ? (filterTasks(tasks, k).length ? " hot" : "") : ""}" href="${esc(hrefOf(v, { k: k === "all" ? null : k }))}#tasks">${label} ${filterTasks(tasks, k).length}</a>`).join("")}</nav>`;
  const cols = COLUMNS.map(([c, label]) => {
    const list = shown.filter((t) => t.col === c);
    const add = c === "todo" && token ? addForm(g.name, token) : "";
    const cards = list.map((t) => taskCard(t, g.name, token, now));
    const fold = c === "done" && cards.length > DONE_SHOWN + 1;
    const body = !cards.length
      ? `<p class="note">없음</p>`
      : fold
        ? `${cards.slice(0, DONE_SHOWN).join("")}<details><summary>나머지 ${cards.length - DONE_SHOWN}개</summary>${cards.slice(DONE_SHOWN).join("")}</details>`
        : cards.join("");
    return `<section class="kc" aria-label="${label}"><h4><span>${label}</span><span>${list.length}</span></h4>${add}${body}</section>`;
  }).join("");
  return `<h3 class="sec" id="tasks"><span>작업 <span>${tasks.length}</span></span></h3>${chips}<div class="kb">${cols}</div>`;
}
