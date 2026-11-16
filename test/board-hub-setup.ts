import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askAdd } from "../src/asks.ts";
import { saveHub } from "../src/board-hub.ts";
import { viewOf } from "../src/board-list-html.ts";
import { projectPane } from "../src/board-projects-html.ts";
import { boardState } from "../src/board-state.ts";
import { Store } from "../src/store.ts";
import type { Item, Lane } from "../src/store-types.ts";

export const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
export const DAY = 86_400_000;
export const PR = (n: number): string => `https://github.com/orangec-at/coupas/pull/${n}`;

export const lane = (key: string, status: Lane["status"], at: number, log: Lane["log"], brief = "/b.md"): Lane => ({
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
export function coupas(): Store {
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

export const V = viewOf(new URLSearchParams("tab=proj&p=coupas"));
export const page = (store: Store): string => {
  const s = boardState(store, NOW);
  return projectPane(s.projects.find((g) => g.name === "coupas")!, s, null, V, NOW, "/");
};
