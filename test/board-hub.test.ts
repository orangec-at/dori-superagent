import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHub, metricDefs, readHub, refreshHub, saveHub } from "../src/board-hub.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const DAY = 86_400_000;

function home(projects: unknown): Store {
  const h = mkdtempSync(join(tmpdir(), "dori-hub-"));
  writeFileSync(join(h, "board.json"), JSON.stringify({ projects }));
  const store = new Store(h);
  store.saveLane({
    key: "coupas-sales",
    sessionRef: { runtime: "herdr", id: "w1:p1" },
    paneId: "w1:p1",
    tabId: "",
    brief: "/b.md",
    cwd: "/home/b/workspace/coupas",
    status: "working",
    createdAt: NOW - DAY,
    lastActivityAt: NOW - 60_000,
    nudges: 0,
    log: [{ at: NOW - 60_000, kind: "report", text: "PR https://github.com/orangec-at/coupas/pull/5" }],
  });
  return store;
}

/** gh lists the repo's PRs; `sh -c` answers per command; `hang` never answers until killed. */
function machine(o: { gh?: "ok" | "fail" | "hang" } = {}) {
  const calls: string[] = [];
  const killed: string[] = [];
  const exec: Exec = async (cmd, argv, options) => {
    const what = cmd === "sh" ? argv[1]! : `${cmd} ${argv.slice(0, 4).join(" ")}`;
    calls.push(what);
    const hang = (cmd === "gh" && o.gh === "hang") || what === "sleep 999";
    if (hang)
      return new Promise((resolve) =>
        options?.onSpawn?.({
          kill: () => {
            killed.push(what);
            resolve({ code: 143, stdout: "", stderr: "" });
          },
        }),
      );
    if (cmd === "gh")
      return o.gh === "fail"
        ? { code: 1, stdout: "", stderr: "HTTP 502" }
        : {
            code: 0,
            stdout: JSON.stringify([
              { number: 5, state: "OPEN", mergedAt: null, closedAt: null },
              { number: 3, state: "MERGED", mergedAt: "2026-11-15T09:00:00Z", closedAt: "2026-11-15T09:00:00Z" },
            ]),
            stderr: "",
          };
    if (what === "false") return { code: 1, stdout: "1원", stderr: "" };
    return { code: 0, stdout: `\n  ${what.replace(/^echo /, "")}  \nmore\n`, stderr: "" };
  };
  return { exec, calls, killed };
}

const METRICS = {
  coupas: {
    words: ["coupas"],
    metrics: [
      { name: "쿠팡 누적 판매 / 목표 150,000원", cmd: "echo 12,300원" },
      { name: "게시 수", file: "posts.txt" },
      { name: "실패", cmd: "false" },
      { name: "멈춤", cmd: "sleep 999" },
      { name: "둘 다", cmd: "echo x", file: "x" },
      { cmd: "echo no-name" },
      "nope",
    ],
  },
  words: ["a"],
};

test("metrics come only from board.json: an entry needs a name and exactly one of cmd or file", () => {
  expect(metricDefs(home(METRICS).root).map((m) => [m.name, m.cmd, m.file])).toEqual([
    ["쿠팡 누적 판매 / 목표 150,000원", "echo 12,300원", null],
    ["게시 수", null, "posts.txt"],
    ["실패", "false", null],
    ["멈춤", "sleep 999", null],
  ]);
  expect(metricDefs(mkdtempSync(join(tmpdir(), "dori-hub-none-")))).toEqual([]);
});

test("one gh call per repo gives each PR's state; a metric shows its first line, or null when it fails or times out", async () => {
  const store = home(METRICS);
  writeFileSync(join(store.root, "posts.txt"), "\n17\n");
  const m = machine();
  const h = await collectHub(m.exec, store, null, { now: NOW, metricTimeoutMs: 30 });
  expect(m.calls.filter((c) => c.startsWith("gh"))).toEqual(["gh pr list --repo orangec-at/coupas"]);
  expect(h.prs).toEqual({
    "orangec-at/coupas#5": { state: "OPEN", mergedAt: null, closedAt: null },
    "orangec-at/coupas#3": {
      state: "MERGED",
      mergedAt: Date.parse("2026-11-15T09:00:00Z"),
      closedAt: Date.parse("2026-11-15T09:00:00Z"),
    },
  });
  expect(h.metrics["coupas"]?.map((x) => [x.name, x.value])).toEqual([
    ["쿠팡 누적 판매 / 목표 150,000원", "12,300원"],
    ["게시 수", "17"],
    ["실패", null],
    ["멈춤", null],
  ]);
  expect(m.killed).toEqual(["sleep 999"]);
});

test("a repo gh cannot read keeps the states the last collection had", async () => {
  const store = home({});
  const last = {
    generatedAt: NOW - DAY,
    prs: {
      "orangec-at/coupas#5": { state: "OPEN" as const, mergedAt: null, closedAt: null },
      "other/repo#1": { state: "CLOSED" as const, mergedAt: null, closedAt: NOW - DAY },
    },
    metrics: {},
  };
  const h = await collectHub(machine({ gh: "fail" }).exec, store, last, { now: NOW });
  expect(h.prs).toEqual({ "orangec-at/coupas#5": { state: "OPEN", mergedAt: null, closedAt: null } });
});

test("refreshHub saves the facts; past its limit it kills gh and keeps the last saved file", async () => {
  const store = home({});
  expect(readHub(store.root)).toBeNull();
  expect(await refreshHub(machine().exec, store, NOW)).toBeNull();
  expect(readHub(store.root)?.prs["orangec-at/coupas#5"]?.state).toBe("OPEN");

  saveHub(store.root, { generatedAt: NOW - DAY, prs: {}, metrics: {} });
  const hung = machine({ gh: "hang" });
  const line = await refreshHub(hung.exec, store, NOW, 30);
  expect(line).toBe("hub: 프로젝트 현황 갱신 시간 초과 (1초), 지난 값을 그대로 둠");
  expect(hung.killed).toEqual(["gh pr list --repo orangec-at/coupas"]);
  expect(readHub(store.root)?.generatedAt).toBe(NOW - DAY);
});
