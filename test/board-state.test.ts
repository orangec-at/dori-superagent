import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askAdd, askClose } from "../src/asks.ts";
import {
  assignmentOf,
  boardState,
  DEFAULT_PROJECTS,
  delegateSummary,
  firstLine,
  kstDate,
  projectOf,
} from "../src/board-state.ts";
import { Store } from "../src/store.ts";
import type { Item, Lane } from "../src/store-types.ts";

const NOW = Date.UTC(2026, 10, 13, 1, 0, 0);

const ASSIGN = `# 아침 배정 2026-11-13

| 봇 | 오늘 결과물 1개 | 근거 |
|---|---|---|
| 판붕이 | V1: Reddit 답글 초안 1개 | V1 |
| 엔도·비도 | 배정 없음 | - |

## 결과
- 판붕이 ⚠️ 첫 시도 실패
- 판붕이 ✅ 초안 1개 drafts/2026-11-13-reddit.md
`;

const AGENTS = [
  { name: "panbungi", host: "ubuntu", profile: "panbungi", role: "sales", description: "판붕이(ubuntu): FMV 영업" },
  { name: "endo", host: "", profile: "endo", role: "review", description: "엔도(fedora): PR 검토" },
  { name: "yeondo", host: "", profile: "yeondo", role: "research", description: "연도(fedora): 리서치" },
];

const lane = (key: string, over: Partial<Lane>): Lane => ({
  key,
  sessionRef: { runtime: "herdr", id: "w1:p5" },
  paneId: "w1:p5",
  tabId: "",
  brief: `/b/${key}.md`,
  cwd: "/repo",
  status: "working",
  createdAt: NOW - 7_200_000,
  lastActivityAt: NOW - 60_000,
  nudges: 0,
  log: [],
  ...over,
});

const item = (id: string, over: Partial<Item>): Item => ({
  id,
  title: id,
  brief: `/b/${id}.md`,
  cwd: "/repo",
  priority: 5,
  status: "open",
  attempts: 0,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  log: [],
  ...over,
});

test("the assignment row and the last result line are read per bot; a bot the file does not name has none", () => {
  expect(assignmentOf(ASSIGN, "판붕이")).toEqual({
    today: "V1: Reddit 답글 초안 1개",
    result: "✅ 초안 1개 drafts/2026-11-13-reddit.md",
  });
  expect(assignmentOf(ASSIGN, "비도")).toEqual({ today: "배정 없음", result: null });
  expect(assignmentOf(ASSIGN, "연도")).toEqual({ today: null, result: null });
  expect(assignmentOf("not a table", "판붕이")).toEqual({ today: null, result: null });
  expect(kstDate(Date.UTC(2026, 10, 12, 15, 30))).toBe("2026-11-13");
});

test("the first line of a report drops hermes box drawing; projects are matched by key, cwd or title", () => {
  expect(firstLine("╭─ panbungi ─╮\n│ 결과: 초안 1개 │\n╰───╯")).toBe("panbungi");
  expect(firstLine("\n\n  done.  \nmore")).toBe("done.");
  expect(delegateSummary("│ drafts/x.md\r\n│ +# 초안\r\n")).toBe("drafts/x.md");
  expect(delegateSummary("알림 확인했어요.\n")).toBe("알림 확인했어요.");
  expect(projectOf(DEFAULT_PROJECTS, "vg-umami", "/home/b/workspace/web")).toBe("vibeguard");
  expect(projectOf(DEFAULT_PROJECTS, "fix-it", "/home/b/workspace/yogaday-worktrees/fix-it")).toBe("yogaday");
  expect(projectOf(DEFAULT_PROJECTS, "phone-board", "/home/b/workspace/dori-superagent-worktrees/x")).toBe("dori");
  expect(projectOf(DEFAULT_PROJECTS, "misc", "/tmp")).toBe("기타");
});

test("board state: open asks, lanes needing the operator, bot cards and lanes grouped by project", () => {
  const root = mkdtempSync(join(tmpdir(), "dori-board-state-"));
  const store = new Store(root);
  writeFileSync(join(root, "agents.json"), JSON.stringify(AGENTS));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out", `daily-assign-${kstDate(NOW)}.md`), ASSIGN);
  writeFileSync(
    join(root, "delegations.jsonl"),
    [
      { at: "2026-11-13T00:10:00.000Z", agent: "panbungi", outcome: "failed", output: "boom" },
      "{cut line",
      {
        at: "2026-11-13T00:50:00.000Z",
        agent: "panbungi",
        outcome: "ok",
        output: "│ drafts/x.md\r\n│ +# 초안\r\n완료: 초안 1개 저장\n",
      },
    ]
      .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
      .join("\n"),
  );
  const options = [{ key: "A", text: "yes" }];
  askAdd(root, "open-q", { question: "ship?", options, now: NOW });
  askAdd(root, "closed-q", { question: "old?", options, now: NOW });
  askClose(root, "closed-q", NOW);
  store.saveLane(lane("vg-umami", { status: "ready", final: { text: "PR 준비\n자세히", evidence: [], at: NOW } }));
  store.saveLane(
    lane("phone-board", {
      cwd: "/w/dori-superagent-worktrees/phone-board",
      log: [{ at: NOW, kind: "report", text: "테스트 통과" }],
    }),
  );
  store.saveLane(lane("yd-old", { status: "done", lastActivityAt: NOW - 2 * 86_400_000 }));
  store.saveItem(item("coupas-c1", { priority: 2, decision: "숫자 확인?" }));
  store.saveItem(item("drop-me", { status: "dropped" }));

  const s = boardState(store, NOW);
  expect(s.asks.map((a) => a.id)).toEqual(["open-q"]);
  expect(s.attention.map((l) => [l.key, l.status, l.first])).toEqual([["vg-umami", "ready", "PR 준비"]]);
  expect(s.bots).toEqual([
    {
      name: "panbungi",
      label: "판붕이",
      role: "sales",
      today: "V1: Reddit 답글 초안 1개",
      result: "✅ 초안 1개 drafts/2026-11-13-reddit.md",
      lastDelegate: { at: "2026-11-13T00:50:00.000Z", outcome: "ok", summary: "완료: 초안 1개 저장" },
    },
    { name: "endo", label: "엔도", role: "review", today: "배정 없음", result: null, lastDelegate: null },
    { name: "yeondo", label: "연도", role: "research", today: null, result: null, lastDelegate: null },
  ]);
  expect(s.projects.map((g) => [g.name, g.lanes.map((l) => l.key), g.backlog.map((i) => i.id), g.done.length])).toEqual(
    [
      ["vibeguard", ["vg-umami"], [], 0],
      ["coupas", [], ["coupas-c1"], 0],
      ["dori", ["phone-board"], [], 0],
    ],
  );
});

test("a home without agents.json, assignment file or delegation log still renders empty bot cards", () => {
  const root = mkdtempSync(join(tmpdir(), "dori-board-empty-"));
  const store = new Store(root);
  expect(boardState(store, NOW)).toEqual({ generatedAt: NOW, asks: [], attention: [], bots: [], projects: [] });
  writeFileSync(join(root, "agents.json"), JSON.stringify(AGENTS.slice(1, 2)));
  expect(boardState(store, NOW).bots).toEqual([
    { name: "endo", label: "엔도", role: "review", today: null, result: null, lastDelegate: null },
  ]);
});
