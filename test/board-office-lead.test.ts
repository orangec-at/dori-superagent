import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendChat } from "../src/board-chat.ts";
import { type LeadPane, leadLive, tabLive } from "../src/board-lead-live.ts";
import { officeTab } from "../src/board-office-html.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store-types.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const MIN = 60_000;
const AGENTS = [{ name: "yeondo", host: "", profile: "y", role: "r", description: "연도(fedora): 리서치" }];
const lane = (key: string, at: number): Lane => ({
  key,
  sessionRef: { runtime: "herdr", id: "w1:p5" },
  paneId: "w1:p5",
  tabId: "",
  brief: "",
  cwd: "/repo",
  status: "working",
  createdAt: at,
  lastActivityAt: at,
  nudges: 0,
  log: [{ at, kind: "start", text: "brief.md" }],
});

function seeded() {
  const s = start();
  writeFileSync(join(s.home, "agents.json"), JSON.stringify(AGENTS));
  s.store.setRole("lead", { runtime: "herdr", id: "w3:p1" });
  return s;
}

test("the lead takes the first seat, named 도리도라 with its role, its pane's status and title, linked to its record", async () => {
  const s = seeded();
  const asked: SessionRef[] = [];
  const live = await tabLive("office", s.store, NOW, async (ref) => {
    asked.push(ref);
    return { status: "working", title: "보드 사무실 작업 조율" };
  });
  expect(asked).toEqual([{ runtime: "herdr", id: "w3:p1" }]);
  expect(live?.bots.map((b) => b.name)).toEqual(["lead", "yeondo"]);
  expect(live?.bots[0]).toMatchObject({
    label: "도리도라",
    role: "조율(lead)",
    status: "working",
    task: "보드 사무실 작업 조율",
  });
  const html = officeTab(live, {});
  expect(html).toContain('<a class="seat o-working" href="/?c=lead" data-bot="lead" data-look="typing"');
  expect(html).toContain('title="도리도라 (조율(lead)) · 일하는 중 · 보드 사무실 작업 조율"');
  expect(html).toContain("<i>보드 사무실 작업 조율</i>");
  expect(await tabLive("live", s.store, NOW)).toMatchObject({ bots: [{ name: "yeondo" }] });
});

test("without a pane title the lead's line and time come from its newest record: a lane it started or a board reply", async () => {
  const s = seeded();
  s.store.saveLane(lane("board-office-lead", NOW - 30 * MIN));
  appendChat(s.home, { at: NOW - 50 * MIN, from: "lead", text: "확인했어요" });
  const idle = async (): Promise<LeadPane> => ({ status: "idle" });
  const lead = (await tabLive("office", s.store, NOW, idle))?.bots[0];
  expect(lead).toMatchObject({
    status: "idle",
    task: "lane board-office-lead 시작",
    word: "대기 · 09:30",
    at: NOW - 30 * MIN,
  });
  appendChat(s.home, { at: NOW - 10 * MIN, from: "lead", text: "PR 올렸어요" });
  expect((await tabLive("office", s.store, NOW, idle))?.bots[0]?.task).toBe("답함 · PR 올렸어요");
});

test("a pane that cannot be read, or no reader at all, is 상태 모름 and the tab still draws", async () => {
  const s = seeded();
  const failed = await tabLive("office", s.store, NOW, async () => {
    throw new Error("herdr down");
  });
  expect(failed?.bots[0]).toMatchObject({ status: "unknown", word: "상태 모름", task: null, at: null });
  const html = officeTab(failed, {});
  expect(html).toContain('<a class="seat o-unknown" href="/?c=lead"');
  expect(html).toContain('<span class="cap">상태 모름</span>');
  expect(leadLive({ status: "gone" }, null, "fedora")).toMatchObject({ status: "unknown", word: "상태 모름" });
  expect(leadLive({ status: "blocked" }, { at: NOW, what: "x" }, "fedora").word).toBe("상태 모름 · 10:00");
  const page = await (await fetch(`${s.url}/?tab=office`, { headers: tailnet() })).text();
  expect(page).toContain('href="/?c=lead"');
  expect(page).toContain("상태 모름");
  expect(page).toContain('href="/?c=bot:yeondo"');
});

test("after a rotation moves the lead to another pane its seat follows roles.json", async () => {
  const asked: string[] = [];
  const s = start({
    leadPane: async (ref) => {
      asked.push(ref.id);
      return { status: "idle" };
    },
  });
  writeFileSync(join(s.home, "agents.json"), JSON.stringify(AGENTS));
  s.store.setRole("lead", { runtime: "herdr", id: "w3:p1" });
  expect(await (await fetch(`${s.url}/?tab=office`, { headers: tailnet() })).text()).toContain(
    'o-idle" href="/?c=lead"',
  );
  s.store.setRole("lead", { runtime: "herdr", id: "w5:p2" });
  expect(await (await fetch(`${s.url}/?tab=office`, { headers: tailnet() })).text()).toContain(
    'o-idle" href="/?c=lead"',
  );
  expect(asked).toEqual(["w3:p1", "w5:p2"]);
});
