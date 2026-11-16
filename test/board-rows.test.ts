import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lanePrs } from "../src/board-prs.ts";
import { boardState } from "../src/board-state.ts";
import { rows } from "../src/board-status.ts";
import { fold } from "../src/board-thread-html.ts";
import type { Lane } from "../src/store-types.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const HOUR = 3_600_000;
const lane = (key: string, over: Partial<Lane>): Lane => ({
  key,
  sessionRef: { runtime: "herdr", id: "w1:p5" },
  paneId: "w1:p5",
  tabId: "",
  brief: `/b/${key}.md`,
  cwd: "/repo",
  status: "working",
  createdAt: NOW - 5 * HOUR,
  lastActivityAt: NOW - 60_000,
  nudges: 0,
  log: [],
  ...over,
});

function seeded() {
  const s = start();
  const { store, home } = s;
  const pr = "https://github.com/orangec-at/dori-superagent/pull/31";
  store.saveLane(
    lane("vg-ready", {
      status: "ready",
      log: [{ at: NOW - HOUR, kind: "report", text: "PR #31 opened" }],
      final: { text: "board on the web", evidence: [pr], at: NOW - 30 * 60_000 },
    }),
  );
  store.saveLane(
    lane("vg-quiet", {
      lastActivityAt: NOW - 3 * HOUR,
      log: [{ at: NOW - 3 * HOUR, kind: "report", text: "half way" }],
    }),
  );
  store.saveLane(
    lane("coupas-wait", { status: "waiting", log: [{ at: NOW - HOUR, kind: "report", text: "need a token" }] }),
  );
  store.saveLane(lane("yd-stuck", { nudges: 3, log: [{ at: NOW - 2 * 60_000, kind: "nudge", text: "idle 40 min" }] }));
  store.saveLane(lane("dh-lost", { status: "lost" }));
  store.saveLane(lane("dori-busy", { log: [{ at: NOW - 60_000, kind: "report", text: "writing tests" }] }));
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify([
      { name: "panbungi", host: "ubuntu", profile: "panbungi", role: "sales", description: "판붕이(ubuntu): 영업" },
      { name: "endo", host: "", profile: "endo", role: "review", description: "엔도(fedora): 검토" },
    ]),
  );
  mkdirSync(join(home, "out"), { recursive: true });
  writeFileSync(
    join(home, "out", "daily-assign-2026-11-13.md"),
    "| 봇 | 결과물 | 근거 |\n|---|---|---|\n| 판붕이 | V1 답글 초안 | V1 |\n| 엔도 | 배정 없음 | - |\n\n- 판붕이 ✅ 초안 1개\n",
  );
  writeFileSync(
    join(home, "delegations.jsonl"),
    `${JSON.stringify({ at: "2026-11-13T00:30:00.000Z", agent: "panbungi", text: "V1 초안을 써 줘", outcome: "ok", output: "│ trace\n초안 1개 저장" })}\n`,
  );
  return s;
}

test("every lead, ask, bot and lane is one row with a status word and a section; the operator's turn comes first", () => {
  const { store } = seeded();
  const all = rows(boardState(store, NOW), NOW);
  const by = Object.fromEntries(all.map((r) => [r.id, [r.section, r.word, r.health]]));
  expect(all[0]?.id).toBe("lead");
  expect(by).toMatchObject({
    "ask:vg-analytics": ["needs", "결정", "stuck"],
    "lane:vg-ready": ["needs", "머지 승인", "ok"],
    "lane:coupas-wait": ["needs", "답 기다림", "stuck"],
    "lane:yd-stuck": ["needs", "ESCALATE", "stuck"],
    "lane:vg-quiet": ["revisit", "조용함", "stuck"],
    "lane:dh-lost": ["revisit", "끊김", "error"],
    "lane:dori-busy": ["working", "작업 중", "ok"],
    "bot:panbungi": ["unread", "결과", "ok"],
    "bot:endo": ["idle", "배정 없음", "idle"],
  });
  expect(all.find((r) => r.id === "lane:vg-ready")?.prs).toEqual([
    { repo: "orangec-at/dori-superagent", num: 31, url: "https://github.com/orangec-at/dori-superagent/pull/31" },
  ]);
});

test("PRs come from report text and evidence URLs, each once", () => {
  const prs = lanePrs({
    log: [
      { at: 1, kind: "report", text: "PR #4 opened, see https://github.com/a/b/pull/4 and PR #9" },
      { at: 2, kind: "ready", text: "https://github.com/a/c/pull/4" },
    ],
  });
  expect(prs.map((p) => `${p.repo ?? "-"}#${p.num}`)).toEqual(["a/b#4", "a/c#4", "-#9"]);
});

test("a wide screen folds long paths and session ids, never a URL", () => {
  const s =
    "session_id: local-e5b6b143b1e465af7723fe381deb546fada4802edd8a and workspace/coupas/queue/2026-11-20-kitchen.md";
  const html = fold(`${s} https://github.com/orangec-at/dori-superagent/pull/26 a/b/c`);
  expect(html).toContain('<span class="ls">local-e5b6b143…</span>');
  expect(html).toContain(
    '<span class="lf">workspace/coupas/queue/2026-11-20-kitchen.md</span><span class="ls">…/2026-11-20-kitchen.md</span>',
  );
  expect(html).toContain(" https://github.com/orangec-at/dori-superagent/pull/26 a/b/c");
  expect(fold("<b>")).toBe("&lt;b&gt;");
});

test("My turn shows only the operator's rows; the PR tab lists lane PRs; a row opens its record", async () => {
  const { url } = seeded();
  const mine = await (await fetch(`${url}/?f=mine`, { headers: tailnet() })).text();
  expect(mine).toContain('class="chip on hot" href="/?f=mine">내 차례 4</a>');
  expect(mine).toContain("<b>vg-ready</b>");
  expect(mine).not.toContain("<b>dori-busy</b>");
  const prs = await (await fetch(`${url}/?tab=pr`, { headers: tailnet() })).text();
  expect(prs).toContain("<b>#31 vg-ready</b>");
  const rec = await (await fetch(`${url}/?c=lane:vg-ready`, { headers: tailnet() })).text();
  expect(rec).toContain('<h3 class="needs">재일 님 차례 <span>1</span></h3>');
  expect(rec).toContain('href="https://github.com/orangec-at/dori-superagent/pull/31"');
  expect(rec).toContain('<a class="back" href="/"');
  const bot = await (await fetch(`${url}/?c=bot:panbungi`, { headers: tailnet() })).text();
  expect(bot).toContain("지시 · ok");
  expect(bot).toContain('<div class="text">초안 1개 저장</div>');
  expect(bot).toContain('<div class="msg them"><span class="mav" aria-hidden="true"><span class="av"');
  expect(bot).toContain('<label class="dtb" for="dt">미션</label>');
  expect(bot).toContain("오늘 배정: V1 답글 초안");
  const lead = await (await fetch(`${url}/`, { headers: tailnet() })).text();
  expect(lead).toContain('<details class="work"><summary>vg-ready · 머지 승인');
});
