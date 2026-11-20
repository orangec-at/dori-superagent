import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotRecords, botLive, JUST_DONE_MS, liveState, taskTitle } from "../src/board-live.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const MIN = 60_000;
const iso = (t: number): string => new Date(t).toISOString();
const jsonl = (rows: object[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
const none: BotRecords = { runs: [], handed: null };
const run = (at: number, end?: { at: number; outcome: string }) => ({
  at,
  until: at + 30 * MIN,
  text: "@yeondo 공개 사례 조사",
  ...(end ? { end } : {}),
});

test("a started run with no end, within its timeout, is 일하는 중 from its start", () => {
  const r = botLive({ runs: [run(NOW - 2 * MIN), run(NOW - 5 * MIN)], handed: null }, NOW);
  expect(r).toEqual({ status: "working", task: "공개 사례 조사", at: NOW - 5 * MIN, running: 2 });
});

test("a run that ended ok is 방금 끝남, then 대기 with no task once JUST_DONE_MS has passed", () => {
  const ended = { runs: [run(NOW - 20 * MIN, { at: NOW - 5 * MIN, outcome: "ok" })], handed: null };
  expect(botLive(ended, NOW)).toEqual({ status: "done", task: "공개 사례 조사", at: NOW - 5 * MIN, running: 0 });
  const later = NOW - 5 * MIN + JUST_DONE_MS;
  expect(botLive(ended, later)).toEqual({ status: "idle", task: null, at: NOW - 5 * MIN, running: 0 });
});

test("a run that failed or timed out is 실패 at its end", () => {
  for (const outcome of ["failed", "timeout"])
    expect(botLive({ runs: [run(NOW - 40 * MIN, { at: NOW - 10 * MIN, outcome })], handed: null }, NOW)).toMatchObject({
      status: "failed",
      at: NOW - 10 * MIN,
    });
});

test("a run past its timeout with no end is 상태 확인 안 됨 at its start, not 일하는 중", () => {
  const stale = { runs: [run(NOW - 3 * 60 * MIN)], handed: null };
  expect(botLive(stale, NOW)).toEqual({
    status: "unknown",
    task: "공개 사례 조사",
    at: NOW - 3 * 60 * MIN,
    running: 0,
  });
});

test("no record at all is 상태 확인 안 됨 with no time", () => {
  expect(botLive(none, NOW)).toEqual({ status: "unknown", task: null, at: null, running: 0 });
});

test("a hand-out with no run started after it is 받음, shown as 상태 확인 안 됨, never 일하는 중", () => {
  const handed = { at: NOW - 10 * MIN, text: "@endo 인용 대조" };
  expect(botLive({ runs: [run(NOW - 60 * MIN, { at: NOW - 50 * MIN, outcome: "ok" })], handed }, NOW)).toEqual({
    status: "unknown",
    task: "인용 대조",
    at: NOW - 10 * MIN,
    running: 0,
  });
  expect(botLive({ runs: [run(NOW - 10 * MIN)], handed }, NOW).status).toBe("working");
});

test("a title is one line of at most 80 characters without links, addresses or tokens; a path keeps its file name", () => {
  expect(
    taskTitle(
      "@yeondo ~/.dori/out/report-1120.md 를 https://example.com/x 와 a@b.co 100.64.0.1 로 abcdefghijklmnopqrstuvwxyz0123456789 정리\n둘째 줄",
    ),
  ).toBe("report-1120.md 를 와 로 정리");
  expect(taskTitle(`@bido ${"가".repeat(100)}`)).toBe(`${"가".repeat(79)}…`);
  expect(taskTitle("@bido 영상 카드 W2-A를 만들어줘. 카드 상품은 물병 v1.2이고 파트너스 링크는 나중에.")).toBe(
    "영상 카드 W2-A를 만들어줘.",
  );
});

function seeded() {
  const s = start();
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify([
      { name: "yeondo", host: "", profile: "yeondo", role: "research", description: "연도(fedora): 리서치" },
      { name: "endo", host: "mac@mac-mini.local", profile: "endo", role: "review", description: "엔도: 검토" },
      { name: "bido", host: "", profile: "bido", role: "assistant", description: "비도(fedora): 비서" },
    ]),
  );
  const yAt = iso(NOW - 2 * MIN);
  const eAt = iso(NOW - 60 * MIN);
  writeFileSync(
    join(s.home, "delegate-runs.jsonl"),
    jsonl([
      { at: eAt, agent: "endo", text: "@endo PR 검토", until: iso(NOW - 30 * MIN) },
      { at: yAt, agent: "yeondo", text: "@yeondo 공개 사례 조사", until: iso(NOW + 28 * MIN) },
    ]),
  );
  writeFileSync(
    join(s.home, "delegations.jsonl"),
    jsonl([
      {
        at: eAt,
        agent: "endo",
        text: "@endo PR 검토",
        outcome: "ok",
        code: 0,
        output: "SECRET-OUTPUT ghp_abc",
        endedAt: iso(NOW - 40 * MIN),
      },
    ]),
  );
  mkdirSync(join(s.home, "autopilot"), { recursive: true });
  return s;
}

test("liveState reads the delegation logs into one row per bot of agents.json, in its order", () => {
  const { store } = seeded();
  expect(liveState(store, NOW)).toEqual({
    generatedAt: NOW,
    bots: [
      {
        name: "yeondo",
        label: "연도",
        machine: "fedora",
        task: "공개 사례 조사",
        status: "working",
        word: "일하는 중",
        at: NOW - 2 * MIN,
        running: 1,
      },
      {
        name: "endo",
        label: "endo",
        machine: "mac-mini",
        task: null,
        status: "idle",
        word: "대기",
        at: NOW - 40 * MIN,
        running: 0,
      },
      {
        name: "bido",
        label: "비도",
        machine: "fedora",
        task: null,
        status: "unknown",
        word: "상태 확인 안 됨",
        at: null,
        running: 0,
      },
    ],
  });
});

test("GET /api/live answers only a writer; the 지금 tab shows titles and states, never a bot's output", async () => {
  const { url } = seeded();
  expect((await fetch(`${url}/api/live`)).status).toBe(403);
  expect((await fetch(`${url}/api/live`, { headers: tailnet({ "tailscale-user-login": "" }) })).status).toBe(403);
  const api = await fetch(`${url}/api/live`, { headers: tailnet() });
  expect(api.status).toBe(200);
  expect(((await api.json()) as { bots: unknown[] }).bots).toHaveLength(3);
  expect((await fetch(`${url}/?tab=live`, { headers: tailnet({ host: "rebind.attacker.example" }) })).status).toBe(403);
  const html = await (await fetch(`${url}/?tab=live`, { headers: tailnet() })).text();
  expect(html).toContain('data-bot="yeondo" data-status="working"');
  expect(html).toContain("공개 사례 조사");
  expect(html).toContain("맡은 일 없음");
  expect(html).toContain("40분 전 완료");
  expect(html).toContain("data-live");
  expect(html).not.toContain("SECRET-OUTPUT");
});
