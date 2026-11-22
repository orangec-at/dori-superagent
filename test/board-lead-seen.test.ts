import { expect, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendChat } from "../src/board-chat.ts";
import { type LeadRecords, leadSeen, newestSeen } from "../src/board-lead-seen.ts";
import { tabLive } from "../src/board-lead-live.ts";
import { NOW, start } from "./board-setup.ts";

type Kind = "start" | "adopt" | "done" | "run" | "ask" | "close" | "reply";
const NEWEST = 200;
const iso = (at: number): string => new Date(at).toISOString();

/** One record of every kind, `newest` the newest of them; the records that never count are newer than the others. */
function records(newest: Kind): LeadRecords {
  const at = (k: Kind, old: number): number => (k === newest ? NEWEST : old);
  const log = [
    { at: at("start", 1), kind: "start" },
    { at: at("adopt", 2), kind: "adopt" },
    { at: at("done", 3), kind: "done" },
    { at: 99, kind: "report" },
    { at: 98, kind: "ready" },
    { at: 97, kind: "nudge" },
  ];
  return {
    lanes: [{ key: "a", log }],
    runs: [
      { at: iso(at("run", 4)), agent: "yeondo", text: "블로그 문장 표를 만들어 줘. 게시 금지" },
      { at: iso(96), agent: "gibungi", text: "[autopilot dh t1] 할 일" },
      { at: iso(94), agent: "endo", text: "[디도 → 엔도, 읽기 전용 확인 요청] 표지 확인" },
    ],
    asks: [{ id: "q1", createdAt: at("ask", 5), closedAt: at("close", 6) }],
    chat: [
      { at: at("reply", 7), from: "lead", text: "PR 올렸어요" },
      { at: 95, from: "operator", text: "해 줘" },
    ],
  };
}

const reversed = (r: LeadRecords): LeadRecords => ({
  lanes: [...r.lanes].reverse().map((l) => ({ ...l, log: [...(l["log"] as unknown[])].reverse() })),
  runs: [...r.runs].reverse(),
  asks: [...r.asks].reverse(),
  chat: [...r.chat].reverse(),
});

const WANT: Record<Kind, string> = {
  start: "lane a 시작",
  adopt: "lane a 맡음",
  done: "lane a 닫음",
  run: "yeondo에게 위임 · 블로그 문장 표를 만들어 줘.",
  ask: "질문 올림 · q1",
  close: "질문 닫음 · q1",
  reply: "답함 · PR 올렸어요",
};

test("of every kind of the lead's records the newest is the one read, whatever order the files list them in", () => {
  for (const [kind, what] of Object.entries(WANT) as [Kind, string][]) {
    expect(newestSeen(records(kind))).toEqual({ at: NEWEST, what });
    expect(newestSeen(reversed(records(kind)))).toEqual({ at: NEWEST, what });
  }
});

test("lane reports, duty nudges, autopilot hand-outs and the operator's lines are not the lead's: alone they are no record", () => {
  expect(newestSeen({ lanes: [], runs: [], asks: [], chat: [] })).toBeNull();
  const r = records("start");
  const log = r.lanes[0]?.["log"] as { kind: string }[];
  expect(
    newestSeen({
      lanes: [{ key: "a", log: log.filter((e) => !["start", "adopt", "done"].includes(e.kind)) }],
      runs: r.runs.filter((d) => d["agent"] !== "yeondo"),
      asks: [{ id: "broken", createdAt: "yesterday" }],
      chat: r.chat.filter((m) => m["from"] === "operator"),
    }),
  ).toBeNull();
});

test("this board's lead reads its lanes, delegate-runs.jsonl, asks and replies from its dori home", async () => {
  const s = start();
  expect(leadSeen(s.store)).toEqual({ at: NOW - 60_000, what: "질문 올림 · vg-analytics" });
  rmSync(join(s.home, "asks", "vg-analytics.json"));
  expect(leadSeen(s.store)).toBeNull();
  appendChat(s.home, { at: NOW - 40 * 60_000, from: "lead", text: "확인했어요" });
  const run = (at: number, agent: string, text: string) =>
    appendFileSync(
      join(s.home, "delegate-runs.jsonl"),
      `${JSON.stringify({ at: iso(at), agent, text, until: iso(at) })}\n`,
    );
  run(NOW - 30 * 60_000, "yeondo", "블로그 표 만들기");
  run(NOW - 5 * 60_000, "gibungi", "[autopilot dh t1] 다른 일");
  expect(leadSeen(s.store)).toEqual({ at: NOW - 30 * 60_000, what: "yeondo에게 위임 · 블로그 표 만들기" });
  const ask = { id: "dh-go", question: "q", options: [], status: "closed", createdAt: NOW - 20 * 60_000 };
  writeFileSync(join(s.home, "asks", "dh-go.json"), JSON.stringify({ ...ask, closedAt: NOW - 10 * 60_000 }));
  s.store.setRole("lead", { runtime: "herdr", id: "w3:p1" });
  const idle = { lead: async () => ({ status: "idle" as const }) };
  expect((await tabLive("office", s.store, NOW, idle))?.bots[0]).toMatchObject({
    task: "질문 닫음 · dh-go",
    word: "대기 · 09:50",
    at: NOW - 10 * 60_000,
  });
});
