import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegate } from "../src/agents.ts";
import { runningDelegations } from "../src/board-agents.ts";
import { appendChat } from "../src/board-chat.ts";
import { boardState } from "../src/board-state.ts";
import type { ExecResult } from "../src/runtime/exec.ts";
import type { Lane } from "../src/store-types.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (t: number): string => new Date(t).toISOString();
const jsonl = (rows: object[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

function seeded() {
  const s = start();
  const { store, home } = s;
  mkdirSync(join(home, "briefs"), { recursive: true });
  writeFileSync(join(home, "briefs", "busy.md"), "# Lane busy: 보드 에이전트 카드\n");
  const lane = (key: string, over: Partial<Lane>): Lane => ({
    key,
    sessionRef: { runtime: "herdr", id: "w1:p5" },
    paneId: "w1:p5",
    tabId: "",
    brief: join(home, "briefs", `${key}.md`),
    cwd: "/repo",
    status: "working",
    createdAt: NOW - 5 * HOUR,
    lastActivityAt: NOW - MIN,
    nudges: 0,
    log: [],
    ...over,
  });
  const pr = "https://github.com/orangec-at/dori-superagent/pull/42";
  store.saveLane(lane("busy", { log: [{ at: NOW - MIN, kind: "report", text: `테스트 작성 중 ${pr}` }] }));
  store.saveLane(lane("quiet", { lastActivityAt: NOW - 3 * HOUR }));
  store.saveLane(lane("asks", { status: "waiting", lastActivityAt: NOW - 2 * 24 * HOUR }));
  store.saveLane(lane("gone", { status: "done" }));
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify(
      [
        ["endo", "엔도(fedora): 검토"],
        ["panbungi", "판붕이(ubuntu): 영업"],
        ["yeondo", "연도(fedora): 리서치"],
        ["bido", "비도(fedora): 비서"],
      ].map(([name, description]) => ({ name, host: "", profile: name, role: "bot", description })),
    ),
  );
  mkdirSync(join(home, "out"), { recursive: true });
  writeFileSync(
    join(home, "out", "daily-assign-2026-11-13.md"),
    "| 봇 | 결과물 | 근거 |\n|---|---|---|\n| 판붕이 | V1 답글 초안 | V1 |\n",
  );
  const panAt = iso(NOW - 30 * MIN);
  writeFileSync(
    join(home, "delegate-runs.jsonl"),
    jsonl([
      { at: iso(NOW - 5 * MIN), agent: "endo", text: "PR #9 검토", until: iso(NOW + 10 * MIN) },
      { at: panAt, agent: "panbungi", text: "V1 초안을 써 줘", until: iso(NOW) },
      { at: iso(NOW - 2 * HOUR), agent: "yeondo", text: "시장 조사", until: iso(NOW - HOUR) },
    ]),
  );
  writeFileSync(
    join(home, "delegations.jsonl"),
    jsonl([{ at: panAt, agent: "panbungi", text: "V1 초안을 써 줘", outcome: "ok", output: "초안 1개 저장" }]),
  );
  appendChat(home, { at: NOW - 5 * MIN, from: "operator", text: "지금 상태 알려 줘", kind: "request" });
  mkdirSync(join(home, "muse"), { recursive: true });
  writeFileSync(join(home, "muse", "inbox.jsonl"), jsonl([{ at: "2026-11-13 09:00", text: "쿠파스 글 올려 주세요" }]));
  writeFileSync(
    join(home, "muse", "audit.jsonl"),
    jsonl([{ at: "2026-11-13T09:30:00+0900", cmd: ["send"], chars: 20, outcome: "sent DELIVERED" }]),
  );
  return s;
}

test("each agent gets a state, one line and its last activity from the lane, delegation, chat and Muse records", () => {
  const { store } = seeded();
  const agents = boardState(store, NOW).agents;
  expect(agents.map((a) => [a.id, a.state, a.line])).toEqual([
    ["lead", "working", "요청 처리 중 · 지금 상태 알려 줘"],
    [
      "lane:busy",
      "working",
      "보드 에이전트 카드 — 테스트 작성 중 https://github.com/orangec-at/dori-superagent/pull/42",
    ],
    ["lane:quiet", "silent", null],
    ["lane:asks", "waiting", null],
    ["bot:endo", "working", "지시: PR #9 검토 · 답 기다리는 중"],
    ["bot:panbungi", "waiting", "지시: V1 초안을 써 줘 · 답함"],
    ["bot:yeondo", "silent", "지시: 시장 조사 · 답 기다리는 중"],
    ["bot:bido", null, null],
    ["muse", "waiting", "요청: 쿠파스 글 올려 주세요"],
  ]);
  const by = (id: string) => agents.find((a) => a.id === id)!;
  expect(by("lead").sub).toBe("리드 · lane 1개 진행 중");
  expect(by("lane:busy")).toMatchObject({
    sub: "lane · 패널 w1:p5",
    links: [{ label: "PR #42", href: "https://github.com/orangec-at/dori-superagent/pull/42" }],
    href: "/?c=lane%3Abusy",
  });
  expect(by("bot:panbungi").sub).toBe("bot · 오늘: V1 답글 초안");
  expect(by("bot:bido")).toMatchObject({ sub: "bot · 오늘: 배정 기록 없음", at: null });
  expect(by("muse")).toMatchObject({
    sub: "외부 협업 · 회신 받음",
    at: Date.parse("2026-11-13T00:30:00Z"),
    href: null,
  });
});

test("dori delegate writes its start before the agent answers, so the board sees the run until its end is logged", async () => {
  const { home } = seeded();
  let answer: (r: ExecResult) => void = () => {};
  const run = delegate(
    () =>
      new Promise<ExecResult>((r) => {
        answer = r;
      }),
    "bido",
    "영상 기획안",
    { home, timeoutMs: 60_000, now: () => NOW },
  );
  expect(runningDelegations(home).map((r) => [r.agent, r.text, r.until])).toEqual([
    ["endo", "PR #9 검토", NOW + 10 * MIN],
    ["yeondo", "시장 조사", NOW - HOUR],
    ["bido", "영상 기획안", NOW + 60_000],
  ]);
  answer({ code: 0, stdout: "기획안 저장", stderr: "" });
  await run;
  expect(runningDelegations(home).map((r) => r.agent)).toEqual(["endo", "yeondo"]);
});

test("the 에이전트 tab lists every agent with 기록 없음 for what nothing records and dims a day-old activity", async () => {
  const { url } = seeded();
  const html = await (await fetch(`${url}/?tab=agent`, { headers: tailnet() })).text();
  expect(html).toContain(`<a class="tab on" href="/?tab=agent">에이전트 3</a>`);
  expect(html).toContain("작업 중 3 · 대기 3 · 응답 없음 2");
  const row = (id: string): string => html.split(`data-agent="${id}"`)[1]!.split("</details>")[0]!;
  expect(row("bot:bido")).toContain(`<span class="ast a-none">기록 없음</span><span class="ago">기록 없음</span>`);
  expect(row("bot:yeondo")).toContain(`<span class="ast a-silent">응답 없음</span>`);
  expect(row("lane:busy")).toContain(`href="https://github.com/orangec-at/dori-superagent/pull/42"`);
  expect(row("lane:busy")).toContain(`<a href="/?c=lane%3Abusy">기록 열기 →</a>`);
  expect(html).toContain(`<details class="ag old" data-agent="lane:asks">`);
  expect(html).toContain(`<details class="ag" data-agent="lane:quiet">`);
  expect(row("muse")).not.toContain("기록 열기");
  expect(await (await fetch(`${url}/`, { headers: tailnet() })).text()).toContain(`href="/?tab=agent">에이전트 3</a>`);
});
