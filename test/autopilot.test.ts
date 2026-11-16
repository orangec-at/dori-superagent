import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS } from "../src/autopilot.ts";
import { readAssignments } from "../src/autopilot-store.ts";
import { dutyTick } from "../src/duty.ts";
import { lastActivity } from "../src/autopilot-stall.ts";
import { parseRoadmap, personOnly } from "../src/roadmap.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";
import { setup as base } from "./harness-setup.ts";

pinEnv(AUTOPILOT_ENV);

const HOUR = 3_600_000;
const NOON_KST = Date.parse("2026-11-16T03:00:00Z");
const COUPAS = `# 쿠파스
- 목표: 쿠팡 파트너스 글·영상
- 담당: hongbungi, bido
- 키워드: 쿠파스
- 완료 기준: 주 5개 초안

## 마일스톤
- 11월: 게시 큐 20개

## 다음 할 일
- [x] 첫 상품 3개 초안
- [ ] 다음 주 후보 5개 초안. 게시는 하지 마
- [ ] 스레드에 게시
- [ ] @bido 쇼츠 검토본 1개
`;

const agent = (name: string) => ({ name, host: "", profile: name, role: "", description: "" });
const iso = (ms: number) => new Date(ms).toISOString();

function setup(roadmaps: Record<string, string>, editedAgo = HOUR, bots = ["hongbungi", "bido"]) {
  const s = base();
  s.w.clock = NOON_KST;
  const home = s.d.store.root;
  writeFileSync(join(home, "agents.json"), JSON.stringify(bots.map(agent)));
  mkdirSync(join(home, "projects"));
  for (const [name, text] of Object.entries(roadmaps)) {
    const file = join(home, "projects", `${name}.md`);
    writeFileSync(file, text);
    utimesSync(file, (NOON_KST - editedAgo) / 1000, (NOON_KST - editedAgo) / 1000);
  }
  const launched: { bot: string; text: string; mission: string | undefined }[] = [];
  const launch = (bot: string, text: string, mission?: string) => launched.push({ bot, text, mission });
  const run = (agentName: string, at: number, end?: number) => {
    const line = { at: iso(at), agent: agentName, text: "쿠파스 일", until: iso(at + 600_000) };
    writeFileSync(join(home, "delegate-runs.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
    if (end !== undefined)
      writeFileSync(join(home, "delegations.jsonl"), `${JSON.stringify({ ...line, endedAt: iso(end) })}\n`, {
        flag: "a",
      });
  };
  return { ...s, home, launched, launch, run };
}

describe("project roadmaps", () => {
  test("parse fields, milestones and tasks; person-only work is marked, a forbidding clause is not", () => {
    const r = parseRoadmap("coupas", "/x/coupas.md", COUPAS, 5);
    expect(r).toMatchObject({ title: "쿠파스", goal: "쿠팡 파트너스 글·영상", owners: ["hongbungi", "bido"] });
    expect(r.keywords).toEqual(["coupas", "쿠파스"]);
    expect(r.milestones).toEqual(["11월: 게시 큐 20개"]);
    expect(r.tasks.map((t) => [t.done, t.kind, t.bot, t.blocked])).toEqual([
      [true, "delegate", undefined, undefined],
      [false, "delegate", undefined, undefined],
      [false, "delegate", undefined, "게시"],
      [false, "delegate", "bido", undefined],
    ]);
    expect(parseRoadmap("p", "f", "## 다음 할 일\n- [ ] [pr] 인덱스 정리\n", 0).tasks[0]!.kind).toBe("pr");
  });

  test("person-only words match whole English words; a request after '하지 말고' still counts", () => {
    expect(["total 지표", "quota 표", "rotate 문서"].map(personOnly)).toEqual([undefined, undefined, undefined]);
    expect(personOnly("OTA 올리기")).toBe("배포");
    expect(personOnly("게시하지 말고 머지해")).toBe("병합");
    expect(personOnly("게시·Muse 전달은 하지 마")).toBeUndefined();
  });
});

describe("autopilot: idle bots get the next roadmap task", () => {
  test("a bot idle past 2h gets its project's next open task; a busy bot and person-only tasks are skipped", async () => {
    const { d, lead, home, launched, launch, run, w } = setup({ coupas: COUPAS });
    run("hongbungi", NOON_KST - 4 * HOUR, NOON_KST - 3 * HOUR);
    run("bido", NOON_KST - 5 * 60_000);
    const lines = await autopilotTick(d, launch);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ bot: "hongbungi", mission: "autopilot-coupas" });
    expect(launched[0]!.text).toContain("다음 주 후보 5개 초안");
    expect(launched[0]!.text).toContain("게시·병합·배포·결제·데이터 삭제·재일 님 개인 계정 글은 하지 말고");
    expect(lines).toEqual([
      "[AUTOPILOT] 유휴 봇 배정: hongbungi 유휴(3시간) -> coupas: 다음 주 후보 5개 초안. 게시는 하지 마",
    ]);
    expect(lead.received.join("\n")).toContain("[AUTOPILOT]");
    expect(readAssignments(home).map((a) => [a.bot, a.reason, a.kind])).toEqual([["hongbungi", "idle", "delegate"]]);
    const status = JSON.parse(readFileSync(join(home, "autopilot", "status.json"), "utf8"));
    expect(status.projects[0].tasks[1].assignment.bot).toBe("hongbungi");

    expect(await autopilotTick(d, launch)).toEqual([]);
    w.clock += IDLE_CHECK_MS;
    expect(await autopilotTick(d, launch)).toEqual([]);
    expect(launched).toHaveLength(1);
  });

  test("01-08 KST hands out nothing; the stop file turns the autopilot off", async () => {
    const { d, home, launched, launch, w } = setup({ coupas: COUPAS });
    w.clock = Date.parse("2026-11-16T18:00:00Z");
    expect(await autopilotTick(d, launch)).toEqual([]);
    w.clock = NOON_KST;
    mkdirSync(join(home, "autopilot"), { recursive: true });
    writeFileSync(join(home, "autopilot", "stop"), "");
    expect(await autopilotTick(d, launch)).toEqual([]);
    expect(launched).toEqual([]);
  });
});

describe("autopilot: a project silent for 24h is reported and handed its next task", () => {
  test("delegate work goes to its bot; the stall is told once a day", async () => {
    const { d, lead, launched, launch, w } = setup({ coupas: COUPAS }, 30 * HOUR, []);
    const lines = await autopilotTick(d, launch);
    expect(launched.map((l) => l.bot)).toEqual(["hongbungi"]);
    expect(lines).toEqual([
      "[REPORT coupas 정체] 30시간째 활동 없음 (마지막: 로드맵 수정 2026-11-14T21:00Z). 자동 생성: hongbungi에게 위임 (다음 주 후보 5개 초안. 게시는 하지 마)",
    ]);
    expect(lead.received.join("\n")).toContain("[REPORT coupas 정체]");
    w.clock += 2 * HOUR;
    expect((await autopilotTick(d, launch)).filter((l) => l.includes("정체"))).toEqual([]);
  });

  test("[pr] work becomes a backlog item that the same duty pass opens as a lane", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dori-test-repo-"));
    const roadmap = `# corpus\n- 경로: ${repo}\n\n## 다음 할 일\n- [ ] [pr] 문서 인덱스 정리\n`;
    const { d, home } = setup({ corpus: roadmap }, 25 * HOUR);
    const events = await dutyTick(d);
    const id = readAssignments(home)[0]!.item!;
    expect(id).toMatch(/^ap-corpus-[0-9a-f]{8}$/);
    expect(existsSync(join(home, "autopilot", "briefs", `${id}.md`))).toBe(true);
    expect(events).toContainEqual({ action: "autostart", detail: `started ${id} (p5)` });
    expect(d.store.lane(id)!.cwd).toBe(repo);
  });

  test("a hung gh or git call is killed after its timeout and the other sources still count", async () => {
    const { d } = setup({});
    const killed: string[] = [];
    const hung = {
      ...d,
      exec: (cmd: string, _argv: readonly string[], o?: { onSpawn?: (p: { kill(): void }) => void }) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
          o?.onSpawn?.({
            kill: () => {
              killed.push(cmd);
              resolve({ code: 143, stdout: "", stderr: "" });
            },
          }),
        ),
    };
    const r = parseRoadmap("corpus", "f", "- 저장소: orangec-at/corpus\n", NOON_KST - HOUR);
    expect(await lastActivity(hung, r, [], [], 5)).toEqual({ at: NOON_KST - HOUR, source: "로드맵 수정" });
    expect(killed).toEqual(["gh", "gh"]);
  });

  test("a lane counts for a project only under its path, not under a sibling with the same prefix", async () => {
    const { d, brief, w } = setup({});
    const repo = mkdtempSync(join(tmpdir(), "dori-test-repo-"));
    mkdirSync(`${repo}-old`);
    const { startLane } = await import("../src/lanes.ts");
    await startLane(d, "other-lane", brief, { cwd: `${repo}-old`, group: "w1" });
    const r = parseRoadmap("proj", "f", `- 경로: ${repo}\n`, 0);
    expect((await lastActivity(d, r, [], [], 5)).source).toBe("로드맵 수정");
    w.clock += 1;
    await startLane(d, "inside-lane", brief, { cwd: repo, group: "w1" });
    expect((await lastActivity(d, r, [], [], 5)).source).toBe("lane inside-lane");
  });
});
