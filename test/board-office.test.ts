import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotLive, LIVE_WORD, type LiveStatus, liveState } from "../src/board-live.ts";
import { officeLook, officeTab, officeZones } from "../src/board-office-html.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const MIN = 60_000;
const bot = (name: string, status: LiveStatus, o: Partial<BotLive> = {}): BotLive => ({
  name,
  label: name,
  machine: "fedora",
  task: null,
  status,
  word: LIVE_WORD[status],
  at: NOW - 5 * MIN,
  running: 0,
  ...o,
});

test("each state has its own look: typing with the title, a check with the time, rest, ! or ? with the title, dim ?", () => {
  expect(officeLook(bot("a", "working", { task: "공개 사례 조사", running: 1 }))).toEqual({
    pose: "typing",
    mark: "bubble",
    dim: false,
    say: "공개 사례 조사",
    caption: "일하는 중",
  });
  expect(officeLook(bot("a", "working", { task: "조사", running: 3 })).caption).toBe("일하는 중 · 3건");
  expect(officeLook(bot("b", "done", { task: "PR 검토" }))).toEqual({
    pose: "sit",
    mark: "check",
    dim: false,
    say: "✓",
    caption: "09:55 끝냄",
  });
  expect(officeLook(bot("c", "idle"))).toEqual({ pose: "rest", mark: null, dim: false, say: "", caption: "대기" });
  expect(officeLook(bot("d", "failed", { task: "빌드" }))).toEqual({
    pose: "sit",
    mark: "bang",
    dim: false,
    say: "빌드",
    caption: "실패 · 09:55",
  });
  expect(officeLook(bot("d", "failed")).say).toBe("!");
  expect(officeLook(bot("u", "unsure", { task: "시안 v4" }))).toEqual({
    pose: "sit",
    mark: "ask",
    dim: false,
    say: "시안 v4",
    caption: "결과 모름 · 09:55",
  });
  expect(officeLook(bot("e", "unknown"))).toEqual({
    pose: "sit",
    mark: "ask",
    dim: true,
    say: "?",
    caption: "상태 확인 안 됨",
  });
  expect(officeLook(bot("e", "unknown", { at: null })).caption).toBe("기록 없음");
});

test("bots are split into one room per machine in agents.json order; the Mac mini's names share a room", () => {
  const zones = officeZones([
    bot("endo", "idle"),
    bot("hong", "working", { machine: "ubuntu" }),
    bot("app", "idle", { machine: "mini" }),
    bot("yeondo", "done"),
    bot("ios", "idle", { machine: "mac-mini" }),
    bot("pan", "failed", { machine: "ubuntu" }),
  ]);
  expect(zones.map((z) => [z.label, z.bots.map((b) => b.name)])).toEqual([
    ["fedora", ["endo", "yeondo"]],
    ["ubuntu", ["hong", "pan"]],
    ["Mac mini", ["app", "ios"]],
  ]);
});

test("a seat shows the state's look and links to the bot's conversation; the title is the only text in a bubble", () => {
  const html = officeTab(
    {
      generatedAt: NOW,
      bots: [
        bot("yeondo", "working", { task: "공개 사례 <조사>", running: 1 }),
        bot("endo", "failed", { machine: "ubuntu" }),
      ],
    },
    { "bot:yeondo": "/avatar/yeondo.png" },
  );
  expect(html).toContain('<a class="seat o-working" href="/?c=bot:yeondo" data-bot="yeondo" data-look="typing"');
  expect(html).toContain("<i>공개 사례 &lt;조사&gt;</i>");
  expect(html).toContain('src="/avatar/yeondo.png"');
  expect(html).toContain('<span class="say m-bang"><i class="one">!</i></span>');
  expect(html).toContain('data-machine="ubuntu"');
  expect(html).toContain("일하는 중 1 · 실패 1");
  expect(html).toContain("data-live");
});

test("with no bots the tab says so; with bots but no records every seat is dim with ? and 기록 없음", () => {
  expect(officeTab(null, {})).toBe(`<p class="note" data-live>agents.json에 봇이 없어요.</p>`);
  expect(officeTab({ generatedAt: NOW, bots: [] }, {})).toContain("agents.json에 봇이 없어요.");
  const s = start();
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify([
      { name: "yeondo", host: "", profile: "yeondo", role: "research", description: "연도(fedora): 리서치" },
      { name: "appminhee", host: "mac@mac-macmini", profile: "a", role: "ios", description: "앱민희(mini): iOS" },
    ]),
  );
  const html = officeTab(liveState(s.store, NOW), {});
  expect(html.match(/class="seat o-unknown"/g)).toHaveLength(2);
  expect(html.match(/<span class="say m-ask"><i class="one">\?<\/i><\/span>/g)).toHaveLength(2);
  expect(html.match(/기록 없음/g)).toHaveLength(2);
  expect(html).toContain('data-machine="Mac mini"');
});

test("the 사무실 tab is served under the 지금 tab's access rules, read only", async () => {
  const s = start();
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify([{ name: "yeondo", host: "", profile: "y", role: "r", description: "연도(fedora): 리서치" }]),
  );
  expect((await fetch(`${s.url}/?tab=office`, { headers: tailnet({ host: "rebind.attacker.example" }) })).status).toBe(
    403,
  );
  const html = await (await fetch(`${s.url}/?tab=office`, { headers: tailnet() })).text();
  expect(html).toContain('class="tab on" href="/?tab=office">사무실</a>');
  expect(html).toContain('href="/?c=bot:yeondo"');
  expect(html).toContain('<section class="room" data-machine="fedora">');
});
