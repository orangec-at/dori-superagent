import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotTick } from "../src/autopilot.ts";
import { lastActivity } from "../src/autopilot-stall.ts";
import { readAssignments } from "../src/autopilot-store.ts";
import { dutyTick } from "../src/duty.ts";
import { parseRoadmap } from "../src/roadmap.ts";
import { COUPAS, HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

describe("autopilot: a project silent for 24h is reported and handed its next task", () => {
  test("a stalled project whose bot is busy waits for the next check instead of doubling its work", async () => {
    const { d, launched, launch, run, w } = setup({ coupas: COUPAS }, 30 * HOUR);
    run("hongbungi", NOON_KST - 60_000, undefined, "다른 일");
    run("bido", NOON_KST - HOUR, NOON_KST - 30 * 60_000, "다른 일");
    expect((await autopilotTick(d, launch)).filter((l) => l.includes("정체"))).toEqual([]);
    expect(launched).toEqual([]);
    w.clock += HOUR;
    expect((await autopilotTick(d, launch)).some((l) => l.includes("[REPORT coupas 정체]"))).toBe(true);
  });

  test("an owner that agents.json does not list is never handed work", async () => {
    const roadmap = "# ghost\n- 담당: ghost\n\n## 다음 할 일\n- [ ] 문서 정리\n";
    const { d, launched, launch } = setup({ ghostproj: roadmap }, 30 * HOUR, []);
    expect((await autopilotTick(d, launch))[0]).toContain("ghost가 agents.json에 없어 넘기지 않음");
    expect(launched).toEqual([]);
  });

  test("delegate work goes to its bot; the stall is told once a day", async () => {
    const { d, lead, launched, launch, w, run } = setup({ coupas: COUPAS }, 30 * HOUR);
    run("hongbungi", NOON_KST - 2 * HOUR, NOON_KST - HOUR, "다른 일");
    run("bido", NOON_KST - 2 * HOUR, NOON_KST - HOUR, "다른 일");
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
