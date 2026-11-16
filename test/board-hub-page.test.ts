import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askAdd } from "../src/asks.ts";
import { saveHub } from "../src/board-hub.ts";
import { briefTitle, nextSteps } from "../src/board-hub-state.ts";
import { viewOf } from "../src/board-list-html.ts";
import { projectPane, projectsList } from "../src/board-projects-html.ts";
import { boardState } from "../src/board-state.ts";
import { Store } from "../src/store.ts";
import type { Item, Lane } from "../src/store-types.ts";

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const DAY = 86_400_000;
const PR = (n: number): string => `https://github.com/orangec-at/coupas/pull/${n}`;

const lane = (key: string, status: Lane["status"], at: number, log: Lane["log"], brief = "/b.md"): Lane => ({
  key,
  sessionRef: { runtime: "herdr", id: "w1:p1" },
  paneId: "w1:p1",
  tabId: "",
  brief,
  cwd: "/home/b/workspace/coupas",
  status,
  createdAt: at - DAY,
  lastActivityAt: at,
  nudges: 0,
  log,
});

const item = (id: string, priority: number, decision?: string): Item => ({
  id,
  title: `${id} 할 일`,
  brief: "",
  cwd: "/home/b/workspace/coupas",
  priority,
  status: "open",
  ...(decision ? { decision } : {}),
  attempts: 0,
  createdAt: NOW - DAY,
  updatedAt: NOW - DAY,
  log: [{ at: NOW - DAY, kind: "add", text: "added" }],
});

/** coupas: one lane at work, one finished this week, one finished last week; two backlog items; one open ask. */
function coupas(): Store {
  const h = mkdtempSync(join(tmpdir(), "dori-hub-page-"));
  writeFileSync(
    join(h, "board.json"),
    JSON.stringify({ projects: { coupas: { words: ["coupas"], note: "쿠팡 파트너스 자동 게시" } } }),
  );
  const store = new Store(h);
  store.saveLane(
    lane("coupas-sales", "working", NOW - 600_000, [
      { at: NOW - 2 * 3_600_000, kind: "start", text: "started" },
      { at: NOW - 600_000, kind: "report", text: `판매 집계 붙임 ${PR(5)}` },
    ]),
  );
  store.saveLane(
    lane("coupas-post", "done", NOW - 3 * DAY, [
      { at: NOW - 5 * DAY, kind: "start", text: "started" },
      { at: NOW - 3 * DAY - 60_000, kind: "ready", text: `게시 자동화 ${PR(3)}` },
      { at: NOW - 3 * DAY, kind: "done", text: "done" },
    ]),
  );
  store.saveLane(
    lane("coupas-ancient", "done", NOW - 6 * DAY, [
      { at: NOW - 10 * DAY, kind: "start", text: "started" },
      { at: NOW - 6 * DAY, kind: "done", text: `옛 작업 ${PR(1)}` },
    ]),
  );
  store.saveItem(item("coupas-next", 2));
  store.saveItem(item("coupas-pick", 1, "A안 또는 B안"));
  askAdd(h, "coupas-price", {
    question: "판매 단가는?",
    options: [
      { key: "A", text: "9,900원" },
      { key: "B", text: "12,900원" },
    ],
    recommend: "A",
    now: NOW - 3_600_000,
  });
  saveHub(h, {
    generatedAt: NOW - 120_000,
    prs: {
      "orangec-at/coupas#5": { state: "OPEN", mergedAt: null, closedAt: null },
      "orangec-at/coupas#3": { state: "MERGED", mergedAt: NOW - 3 * DAY, closedAt: NOW - 3 * DAY },
      "orangec-at/coupas#1": { state: "MERGED", mergedAt: NOW - 9 * DAY, closedAt: NOW - 9 * DAY },
    },
    metrics: {
      coupas: [
        { name: "쿠팡 누적 판매 / 목표 150,000원", value: "12,300원", at: NOW - 120_000 },
        { name: "게시 수", value: null, at: NOW - 120_000 },
      ],
    },
  });
  return store;
}

const V = viewOf(new URLSearchParams("tab=proj&p=coupas"));
const page = (store: Store): string => {
  const s = boardState(store, NOW);
  return projectPane(s.projects.find((g) => g.name === "coupas")!, s, null, V, NOW, "/");
};

test("the status card opens the page: badge, purpose, numbers, the operator's decisions, then the next steps", () => {
  const html = page(coupas());
  const card = html.slice(html.indexOf('class="hub"'), html.indexOf("</section>"));
  expect(html.indexOf('class="hub"')).toBeLessThan(html.indexOf("진행 중 lane"));
  expect(card).toContain('<span class="bdg b-turn">재일 님 차례</span>');
  expect(card).toContain("쿠팡 파트너스 자동 게시");
  expect(card).toContain("<b>12,300원</b>");
  expect(card).toContain('<b class="unk">알 수 없음</b>');
  expect(card).toContain("재일 님이 결정할 것 2");
  expect(card.indexOf("판매 단가는?")).toBeLessThan(card.indexOf("결정 필요: A안 또는 B안"));
  expect(card).toContain('href="/?c=ask%3Acoupas-price"');
  expect(card.indexOf("재일 님이 결정할 것")).toBeLessThan(card.indexOf("다음 할 일"));
  expect(card).toContain(`<li>coupas-sales — 판매 집계 붙임 ${PR(5)}</li>`);
  expect(card).toContain("<li>다음: coupas-next 할 일</li>");
});

test("PRs: open and merged this week are shown with their state; older ones fold under 지난 PR", () => {
  const html = page(coupas());
  const shown = html.slice(html.indexOf('<h3 class="sec"><span>PR'), html.indexOf("지난 PR"));
  expect(shown).toContain(
    '<span class="st st-OPEN">열림</span><a class="pr" href="https://github.com/orangec-at/coupas/pull/5"',
  );
  expect(shown).toContain(
    '<span class="st st-MERGED">병합</span><a class="pr" href="https://github.com/orangec-at/coupas/pull/3"',
  );
  expect(shown).not.toContain('pull/1"');
  expect(html).toMatch(
    /<summary>지난 PR 1개<\/summary><ul class="pjm"><li><span class="st st-MERGED">병합<\/span><a class="pr" href="[^"]+pull\/1"/,
  );
});

test("the timeline lists the week oldest first, one icon per kind; older events are left out", () => {
  const html = page(coupas());
  const tl = html.slice(html.indexOf('<ol class="ptl">'), html.indexOf("</ol>", html.indexOf('<ol class="ptl">')));
  const kinds = [...tl.matchAll(/<li class="k-(\w+)">/g)].map((m) => m[1]);
  expect(kinds).toEqual(["done", "start", "ready", "done", "merged", "backlog", "backlog", "start"]);
  expect(tl).toContain('<span class="ti" aria-hidden="true">⑂</span>');
  expect(tl).toContain("#3 coupas-post");
  expect(tl.split("coupas-ancient").length - 1).toBe(2);
  expect(tl).toContain("11/13 18:00");
});

test("the badge: a lost lane is 막힘, work alone is 진행 중, nothing is 쉬는 중; the list shows it with one next step", () => {
  const store = coupas();
  const s = boardState(store, NOW);
  const list = projectsList(s, null, V, NOW);
  expect(list).toMatch(/<b>coupas<\/b><span class="bdg b-turn">재일 님 차례<\/span>/);
  expect(list).toContain('<span class="rs">결정: 판매 단가는?</span>');

  const calm = new Store(mkdtempSync(join(tmpdir(), "dori-hub-calm-")));
  writeFileSync(join(calm.root, "board.json"), JSON.stringify({ projects: { idle: { note: "쉬는 프로젝트" } } }));
  calm.saveLane(
    lane("coupas-sales", "working", NOW - 600_000, [{ at: NOW - 600_000, kind: "report", text: "집계 중" }]),
  );
  const c = boardState(calm, NOW);
  const calmList = projectsList(c, null, V, NOW);
  expect(calmList).toMatch(/<b>coupas<\/b><span class="bdg b-active">진행 중<\/span>/);
  expect(calmList).toContain('<span class="rs">coupas-sales — 집계 중</span>');
  expect(calmList).toMatch(/<b>idle<\/b><span class="bdg b-rest">쉬는 중<\/span>/);
  expect(calmList).toContain("쉬는 프로젝트 · 진행 중인 일 없음");

  calm.saveLane(lane("coupas-sales", "lost", NOW - 600_000, [{ at: NOW - 600_000, kind: "lost", text: "pane gone" }]));
  expect(projectsList(boardState(calm, NOW), null, V, NOW)).toMatch(
    /<b>coupas<\/b><span class="bdg b-blocked">막힘<\/span>/,
  );
});

test("without a note the purpose is the newest lane's brief title, its key prefix dropped", () => {
  const h = mkdtempSync(join(tmpdir(), "dori-hub-brief-"));
  const brief = join(h, "brief.md");
  writeFileSync(brief, "intro\n# Lane coupas-sales: 판매 숫자를 보드에 붙인다\n\nbody\n");
  const store = new Store(h);
  store.saveLane(lane("coupas-sales", "working", NOW - 600_000, [], brief));
  expect(page(store)).toContain('<p class="hb-p">판매 숫자를 보드에 붙인다</p>');
});

test("next steps take at most two lanes; a brief title strips a key even with regex characters", () => {
  const working = (key: string) => ({
    key,
    status: "working" as const,
    at: 0,
    first: "보고",
    full: "",
    prs: [],
    escalated: false,
  });
  const lanes = ["a-1", "a-2", "a-3"].map(working);
  expect(nextSteps({ lanes, backlog: [] })).toEqual(["a-1 — 보고", "a-2 — 보고"]);
  const f = join(mkdtempSync(join(tmpdir(), "dori-hub-title-")), "b.md");
  writeFileSync(f, "# Lane a(b+: 목적\n");
  expect(briefTitle(f, "a(b+")).toBe("목적");
  expect(briefTitle(f, "x.y")).toBe("Lane a(b+: 목적");
});
