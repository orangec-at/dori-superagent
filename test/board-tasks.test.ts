import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { viewOf } from "../src/board-list-html.ts";
import { boardSeed } from "../src/board-projects.ts";
import { projectPane } from "../src/board-projects-html.ts";
import { boardState } from "../src/board-state.ts";
import { daysUntil, milestonesOf, nextDue, progressOf, projectTasks, type Task } from "../src/board-tasks.ts";
import { coupas, NOW } from "./board-hub-setup.ts";

const tasksOf = (store = coupas()) => {
  const s = boardState(store, NOW);
  const g = s.projects.find((p) => p.name === "coupas")!;
  return { s, g, tasks: projectTasks(g, s.bots, NOW) };
};
const cols = (tasks: Task[]) => Object.fromEntries(tasks.map((t) => [t.id, t.col]));

test("lanes and backlog items become one task list in four columns, the operator's first", () => {
  const { tasks } = tasksOf();
  expect(cols(tasks)).toEqual({
    "coupas-pick": "todo",
    "coupas-next": "todo",
    "coupas-sales": "doing",
    "coupas-post": "done",
    "coupas-ancient": "done",
  });
  expect(tasks[0]).toMatchObject({ id: "coupas-pick", mine: true, decision: "A안 또는 B안", editable: true });
  expect(tasks.find((t) => t.id === "coupas-sales")).toMatchObject({ kind: "lane", prs: [5], editable: false });
});

test("a backlog item already running as a lane is that lane, with the item's priority", () => {
  const store = coupas();
  const item = store.item("coupas-next")!;
  store.saveItem({ ...item, id: "coupas-sales", status: "running" });
  const sales = tasksOf(store).tasks.filter((t) => t.id === "coupas-sales");
  expect(sales).toEqual([expect.objectContaining({ kind: "lane", col: "doing", priority: 2 })]);
});

test("milestones: shape checked, progress counts finished keys, the nearest unfinished due date is next", () => {
  expect(milestonesOf(undefined)).toEqual([]);
  expect(milestonesOf([{ name: "출시", due: "2026-11-30", items: ["a"] }])).toEqual([
    { name: "출시", due: "2026-11-30", items: ["a"] },
  ]);
  expect(milestonesOf([{ name: "출시", due: "11/30" }])).toBeNull();
  expect(milestonesOf([{ due: "2026-11-30" }])).toBeNull();
  expect(boardSeed("x", { milestones: "soon" })).toBeNull();
  const { tasks } = tasksOf();
  const beta = { name: "베타", due: "2026-11-20", items: ["coupas-post", "coupas-sales"] };
  const done = { name: "준비", due: "2026-11-18", items: ["coupas-post"] };
  expect(progressOf(beta, tasks)).toEqual({ done: 1, total: 2 });
  expect(nextDue([done, beta, { name: "언젠가", due: null, items: ["coupas-next"] }], tasks)).toBe(beta);
  expect(daysUntil("2026-11-20", NOW)).toBe(4);
  expect(daysUntil("2026-11-15", NOW)).toBe(-1);
});

test("the project page shows who runs it, the next due date, milestone bars and the task columns", () => {
  const store = coupas();
  writeFileSync(
    join(store.root, "board.json"),
    JSON.stringify({
      projects: {
        coupas: {
          words: ["coupas"],
          note: "쿠팡 파트너스 자동 게시",
          milestones: [{ name: "베타", due: "2026-11-20", items: ["coupas-post", "coupas-sales"] }],
        },
      },
    }),
  );
  const { s, g } = tasksOf(store);
  const html = projectPane(g, s, null, viewOf(new URLSearchParams("tab=proj&p=coupas")), NOW, "/");
  expect(html).toContain("<dt>담당</dt><dd>lead 도리도라 · lane 1</dd>");
  expect(html).toContain('<dt>다음 마감</dt><dd><span class="">11/20 베타 · D-4</span></dd>');
  expect(html).toContain('<progress max="2" value="1" aria-label="베타 진행률"></progress>');
  for (const label of ["할 일", "진행 중", "검토", "완료"])
    expect(html).toContain(`<section class="kc" aria-label="${label}">`);
  expect(html).toContain('<p class="q">결정 필요: A안 또는 B안</p>');
});

test("the filter chips narrow the columns; a reader gets no forms, a writer gets them", () => {
  const { s, g } = tasksOf();
  const mine = projectPane(g, s, null, viewOf(new URLSearchParams("tab=proj&p=coupas&k=mine")), NOW, "/");
  const at = mine.indexOf('id="tasks"');
  const board = mine.slice(at, mine.indexOf("<h3", at));
  expect(board).toContain("coupas-pick 할 일");
  expect(board).not.toContain("coupas-next 할 일");
  expect(mine).toContain('<a class="chip on hot" href="/?tab=proj&amp;p=coupas&amp;k=mine#tasks">내 차례 1</a>');
  const v = viewOf(new URLSearchParams("tab=proj&p=coupas"));
  expect(projectPane(g, s, null, v, NOW, "/")).not.toContain('action="/backlog"');
  const writer = projectPane(g, s, null, v, NOW, "/", "tok");
  expect(writer).toContain('<input type="hidden" name="action" value="add">');
  expect(writer).toContain(
    '<input type="hidden" name="id" value="coupas-next"><input type="hidden" name="action" value="priority">',
  );
  expect(writer).not.toContain('name="id" value="coupas-sales"');
});
