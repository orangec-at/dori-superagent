import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegate } from "../src/agents.ts";
import { boardState } from "../src/board-state.ts";
import { Refusal } from "../src/refusal.ts";
import type { Exec } from "../src/runtime/exec.ts";
import type { Lane } from "../src/store-types.ts";
import { NOW, post, start, tailnet, tokenOf } from "./board-setup.ts";

const HOUR = 3_600_000;
const PR = "https://github.com/vibeguard-run/web/pull/9";
const ASSIGN = "tag:아침 배정 2026-11-13";

function seeded() {
  const s = start();
  const { store, home } = s;
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify([
      { name: "panbungi", host: "ubuntu", profile: "panbungi", role: "sales", description: "판붕이(ubuntu): 영업" },
      { name: "endo", host: "", profile: "endo", role: "review", description: "엔도(fedora): 검토" },
      { name: "yoridori", host: "", profile: "yoridori", role: "yoga", description: "요리도리(fedora): 초안" },
    ]),
  );
  mkdirSync(join(home, "out"), { recursive: true });
  writeFileSync(
    join(home, "out", "daily-assign-2026-11-13.md"),
    "| 봇 | 결과물 | 근거 |\n|---|---|---|\n| 판붕이 | V1 답글 초안 | V1 |\n| 요리도리 | Threads 초안 이슈 | YD |\n| 엔도 | 배정 없음 | - |\n\n" +
      `- 판붕이 ✅ 초안 1개, ${"긴 설명 ".repeat(30)} https://github.com/orangec-at/team-board/issues/3#issuecomment-1\n` +
      "- 요리도리 ✅ 초안 https://github.com/orangec-at/yogaday.love/issues/93\n",
  );
  const line = (o: Record<string, unknown>) => `${JSON.stringify({ code: 0, ...o })}\n`;
  writeFileSync(
    join(home, "delegations.jsonl"),
    line({
      at: "2026-11-13T00:05:00.000Z",
      agent: "panbungi",
      text: "[아침 배정 2026-11-13] V1 초안",
      outcome: "ok",
      output: "│ trace\n초안 저장",
    }) +
      line({
        at: "2026-11-13T00:20:00.000Z",
        agent: "endo",
        text: "랜딩 문구 미리 봐 줘",
        outcome: "ok",
        output: "괜찮아요",
        mission: "vg-launch",
      }) +
      line({
        at: "2026-11-13T00:40:00.000Z",
        agent: "endo",
        text: "CI 봐 줘",
        outcome: "timeout",
        output: "no answer",
      }),
  );
  mkdirSync(join(home, "muse"), { recursive: true });
  writeFileSync(
    join(home, "muse", "inbox.jsonl"),
    `${JSON.stringify({ at: "2026-11-13 09:50", text: "yogaday #93 게시 부탁해요" })}\n`,
  );
  writeFileSync(join(home, "briefs", "vg-web.md"), "# vg-web: 랜딩 문구 바꾸기\n\n본문\n");
  const lane: Lane = {
    key: "vg-web",
    sessionRef: { runtime: "herdr", id: "w1:p5" },
    paneId: "w1:p5",
    tabId: "",
    brief: join(home, "briefs", "vg-web.md"),
    cwd: "/repo",
    status: "ready",
    createdAt: NOW - 3 * HOUR,
    lastActivityAt: NOW - HOUR / 2,
    nudges: 0,
    mission: "vg-launch",
    log: [
      { at: NOW - 3 * HOUR, kind: "start", text: "/b/vg-web.md" },
      { at: NOW - 2 * HOUR, kind: "report", text: `PR 열었어요 ${PR}` },
      { at: NOW - HOUR / 2, kind: "ready", text: "문구 바꿈" },
    ],
    final: { text: "문구 바꿈", evidence: [PR], at: NOW - HOUR / 2 },
  };
  store.saveLane(lane);
  store.saveReceipt({
    pr: "vibeguard-run/web#9",
    sha: "abcdef1234567",
    verdict: "CLEAR",
    model: "m",
    at: NOW - HOUR,
    summary: "",
  });
  return s;
}

const flow = (steps: { from: string; to: string; what: string; state: string }[]) =>
  steps.map((s) => `${s.from}>${s.to} ${s.state} ${s.what.slice(0, 18)}`);

test("records sharing a --mission tag, a [tag] or a PR become one mission, in time order, with its hand-overs", () => {
  const { store } = seeded();
  const s = boardState(store, NOW);
  const launch = s.missions.find((m) => m.id === "mission:vg-launch")!;
  expect(flow(launch.steps)).toEqual([
    "lead>lane:vg-web ok 시작 · 랜딩 문구 바꾸기",
    "lane:vg-web>lead ok PR 열었어요 https://gi",
    "lane:vg-web>bot:endo ok PR #9 리뷰 요청",
    "bot:endo>lane:vg-web ok 리뷰 CLEAR @abcdef1",
    "lead>bot:endo ok 지시 · 랜딩 문구 미리 봐 줘",
    "bot:endo>lead ok 괜찮아요",
    "lane:vg-web>lead needs READY · 문구 바꿈",
  ]);
  expect([launch.status, launch.needs, launch.actors.map((a) => `${a.label}/${a.sub}`)]).toEqual([
    "진행",
    "lane:vg-web",
    ["도리도라/lead", "vg-web/lane", "엔도/fedora"],
  ]);
  const morning = s.missions.find((m) => m.id === ASSIGN)!;
  expect(flow(morning.steps)).toEqual([
    "lead>bot:yoridori wait 배정 · Threads 초안 이슈",
    "lead>bot:panbungi ok 지시 · V1 초안",
    "bot:panbungi>lead ok 초안 저장",
    "bot:panbungi>lead ok 결과 · ✅ 초안 1개, 긴 설명",
    "bot:panbungi>gh:orangec-at/team-board ok 이슈 #3 댓글",
    "lead>muse ok 받은편지함 · yogaday #9",
    "bot:yoridori>lead ok 결과 · ✅ 초안 https://",
    "bot:yoridori>gh:orangec-at/yogaday.love ok 이슈 #93",
  ]);
  expect(morning.status).toBe("완료");
  expect(s.missions.find((m) => m.title === "CI 봐 줘")?.status).toBe("막힘");
});

test("each bot, standing lead and lane row has a mission card: role, today's mission, status, last result and its flow", () => {
  const { store } = seeded();
  const { cards } = boardState(store, NOW);
  expect(cards["bot:panbungi"]).toMatchObject({
    role: "sales · 영업",
    mission: "V1 답글 초안",
    status: "완료",
    missionId: ASSIGN,
  });
  expect(cards["bot:endo"]).toMatchObject({ mission: "오늘 배정 없음", status: "막힘" });
  expect(cards["lane:vg-web"]).toEqual({
    role: "도리도라가 맡긴 lane",
    note: "미션 태그 vg-launch",
    mission: "랜딩 문구 바꾸기",
    status: "완료",
    result: "문구 바꿈",
    href: PR,
    missionId: "mission:vg-launch",
  });
});

test("the mission tab lists missions; a mission opens as a map and a timeline; records start with their card", async () => {
  const { url, sent } = seeded();
  const list = await (await fetch(`${url}/?tab=mission`, { headers: tailnet() })).text();
  expect(list).toContain('href="/?tab=mission&amp;m=mission%3Avg-launch#mtop"><span class="avs">');
  expect(list).toContain("<b>아침 배정 2026-11-13</b>");
  const page = await (await fetch(`${url}/?m=mission%3Avg-launch`, { headers: tailnet() })).text();
  expect(page).toContain('<body class="has-c">');
  expect(page).toContain(
    '<a class="ask mneeds" href="/?c=lane%3Avg-web"><b>재일 님 차례</b> · vg-web 머지 승인 확인 →</a>',
  );
  expect(page).toContain('<div class="grid" style="grid-template-columns:repeat(3,minmax(120px,1fr))">');
  expect(page).toContain('class="ms ms-needs d-l" style="--k:2;grid-column:1/3;grid-row:8"');
  expect(page).toContain('<ol class="tl">');
  expect(page).toContain('<input type="hidden" name="c" value="lane:vg-web">');
  expect(page).toContain('<aside class="detail" aria-label="참여"><div class="dh"><b>vg-launch</b>');
  const bot = await (await fetch(`${url}/?c=bot:panbungi`, { headers: tailnet() })).text();
  expect(bot).toContain('<section class="mcard inline"><p class="mk">미션 <span class="st st-ok">완료</span></p>');
  expect(bot).toContain(`<a href="/?m=${encodeURIComponent(ASSIGN)}#mtop">협업 흐름 보기 →</a>`);
  expect(bot).toContain('<span class="rm">🎯 완료 · V1 답글 초안</span>');
  const res = await post(url, "/request", { csrf: await tokenOf(url), c: "lane:vg-web", text: "PR 봐 줘" }, tailnet());
  expect(res.status).toBe(303);
  expect(sent[0]).toContain("(lane:vg-web) PR 봐 줘");
});

test("bot-chat layout: list rows start with avatars, a phone gets the avatar strip, a wide screen the detail pane", async () => {
  const { url } = seeded();
  const bot = await (await fetch(`${url}/?c=bot:panbungi`, { headers: tailnet() })).text();
  expect(bot).toContain('<nav class="strip" aria-label="봇"><a class="sa" href="/?c=lead">');
  expect(bot).toContain('<span class="ra"><span class="av" style="--h:');
  expect(bot).toContain('<aside class="detail" aria-label="상세"><div class="dh"><span class="av xl"');
  expect(bot).toContain(
    '<b>아침 배정</b><span class="meta">매일 09:00 KST · 봇마다 결과물 1개 · 마지막 1시간 전</span>',
  );
  expect(bot).toContain(`<a class="dm" href="/?m=${encodeURIComponent(ASSIGN)}#mtop">`);
});

test("a retry that succeeds clears a failure; old lanes leave; Muse needs the repo name before #N; only web links are links", () => {
  const { store, home } = seeded();
  const at = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const line = (o: Record<string, unknown>) => `${JSON.stringify({ code: 0, output: "ok", ...o })}\n`;
  writeFileSync(
    join(home, "delegations.jsonl"),
    line({ at: at(30), agent: "endo", text: "[재시도] CI", outcome: "timeout" }) +
      line({ at: at(20), agent: "endo", text: "[재시도] CI", outcome: "ok" }),
  );
  writeFileSync(
    join(home, "muse", "inbox.jsonl"),
    `${JSON.stringify({ at: "2026-11-13 09:50", text: "webyogadaybook #93 아님" })}\n`,
  );
  const { mission: _, ...old } = store.lane("vg-web")!;
  store.saveLane({ ...old, key: "vg-old", status: "lost", lastActivityAt: NOW - 8 * 24 * HOUR });
  const s = boardState(store, NOW);
  expect(s.missions.find((m) => m.id === "tag:재시도")?.status).toBe("완료");
  expect(s.missions.some((m) => m.id === "lane:vg-old")).toBe(false);
  expect(s.missions.find((m) => m.id === ASSIGN)?.steps.some((st) => st.to === "muse")).toBe(false);
});

test("evidence that is not a web link or a board path is shown as text", async () => {
  const { store, url } = seeded();
  const bads = ["javascript:alert(1)", "/\\evil.example", "//evil.example", "/\t/evil.example", "/\n/evil.example"];
  for (const href of [...bads, "/?c=lead"]) {
    store.saveLane({ ...store.lane("vg-web")!, final: { text: "x", evidence: [href], at: NOW } });
    const page = await (await fetch(`${url}/?c=lane:vg-web`, { headers: tailnet() })).text();
    expect(page.includes(`<a href="${href}">`)).toBe(href === "/?c=lead");
  }
});

test("a --mission run tagged [아침 배정] is handed in both missions, so the assignment does not wait on it; its issues hand over in the mission only", () => {
  const { store, home } = seeded();
  const path = join(home, "delegations.jsonl");
  const output = "https://github.com/orangec-at/yogaday.love/issues/94\n초안 올림";
  const run = { code: 0, at: "2026-11-13T00:30:00.000Z", agent: "yoridori", outcome: "ok", output };
  const text = "[아침 배정 2026-11-13] Threads 초안";
  writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({ ...run, text, mission: "yd-threads" })}\n`);
  const s = boardState(store, NOW);
  const handed = (id: string) => flow(s.missions.find((m) => m.id === id)!.steps).filter((f) => f.includes("yoridori"));
  expect(handed(ASSIGN).slice(0, 2)).toEqual([
    "lead>bot:yoridori ok 지시 · Threads 초안",
    "bot:yoridori>lead ok 초안 올림",
  ]);
  expect(handed(ASSIGN).some((f) => f.includes(" wait ") || f.includes("이슈 #94"))).toBe(false);
  expect(handed("mission:yd-threads")).toEqual([
    "lead>bot:yoridori ok 지시 · Threads 초안",
    "bot:yoridori>lead ok 초안 올림",
    "bot:yoridori>gh:orangec-at/yogaday.love ok 이슈 #94",
  ]);
});

test("dori delegate --mission writes the tag to the log line; a tag that is not a key is refused", async () => {
  const { home } = seeded();
  const exec: Exec = async () => ({ code: 0, stdout: "ok", stderr: "" });
  await delegate(exec, "endo", "봐 줘", { home, timeoutMs: 60_000, now: () => NOW, mission: "vg-launch" });
  const last = readFileSync(join(home, "delegations.jsonl"), "utf8").trim().split("\n").at(-1)!;
  expect(JSON.parse(last)).toMatchObject({ agent: "endo", mission: "vg-launch" });
  await expect(
    delegate(exec, "endo", "x", { home, timeoutMs: 1000, now: () => NOW, mission: "Bad Tag" }),
  ).rejects.toThrow(Refusal);
});
