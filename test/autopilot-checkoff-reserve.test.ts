import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotTick } from "../src/autopilot.ts";
import { readAssignments, readState, writeJson } from "../src/autopilot-store.ts";
import { HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

const stalled = (project: string, bot: string) =>
  `# ${project}\n- 담당: ${bot}\n\n## 다음 할 일\n- [ ] 조사 메모 초안\n`;
const apple = (out: string) => `# apple\n- 담당: endo\n\n## 다음 할 일\n- [ ] ${out}/a.md에 써줘\n- [ ] 두 번째 메모\n`;

/**
 * Pass 1 (idle only) hands endo apple's first task at noon; its run ends ok at 12:01 with a fresh output. `stalls`
 * are projects silent for 30 hours; bido ran recently, so only a stall check can hand it work.
 */
function start(stalls: Record<string, string>) {
  const s = setup(stalls, 30 * HOUR, ["endo", "bido"]);
  const out = join(s.home, "out");
  mkdirSync(out);
  writeFileSync(join(s.home, "projects", "apple.md"), apple(out));
  writeJson(s.home, "state.json", { ...readState(s.home), stallCheckAt: NOON_KST });
  s.run("bido", NOON_KST - HOUR, NOON_KST - 30 * 60_000, "별도 조사");
  return { ...s, out };
}

async function finishFirst(s: ReturnType<typeof start>) {
  await autopilotTick(s.d, s.launch);
  expect(s.launched.map((l) => [l.bot, l.mission])).toEqual([["endo", "autopilot-apple"]]);
  s.run("endo", NOON_KST + 30_000, NOON_KST + 60_000, s.launched[0]!.text);
  writeFileSync(join(s.out, "a.md"), "결과");
  utimesSync(join(s.out, "a.md"), (NOON_KST + 50_000) / 1000, (NOON_KST + 50_000) / 1000);
}

describe("autopilot: a completion and the stall check in one pass hand each bot at most one delegation", () => {
  test("completion_then_idle_assignment_is_reserved_for_stall_pass", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dori-test-repo-"));
    const s = start({ northwind: stalled("northwind", "endo"), eastwind: stalled("eastwind", "bido") });
    const pr = join(s.home, "projects", "westwind.md");
    writeFileSync(pr, `# westwind\n- 경로: ${repo}\n\n## 다음 할 일\n- [ ] [pr] 문서 인덱스 정리\n`);
    utimesSync(pr, (NOON_KST - 30 * HOUR) / 1000, (NOON_KST - 30 * HOUR) / 1000);
    await finishFirst(s);
    s.run("bido", NOON_KST + 2 * HOUR, NOON_KST + 2.5 * HOUR, "별도 조사");
    s.w.clock = NOON_KST + 3 * HOUR;
    const lines = await autopilotTick(s.d, s.launch);
    expect(lines[0]).toStartWith("[AUTOPILOT 완료] endo apple:");
    expect(s.launched.map((l) => [l.bot, l.mission])).toEqual([
      ["endo", "autopilot-apple"],
      ["endo", "autopilot-apple"],
      ["bido", "autopilot-eastwind"],
    ]);
    expect(s.launched[1]!.text).toContain("두 번째 메모");
    expect(readAssignments(s.home).map((a) => [a.project, a.kind])).toEqual([
      ["apple", "delegate"],
      ["apple", "completed"],
      ["apple", "delegate"],
      ["eastwind", "delegate"],
      ["westwind", "backlog"],
    ]);
    expect(readState(s.home).stallReportedAt["northwind"]).toBeUndefined();
  });

  test("completion_then_stall_only_assignment_reserves_bot_in_loop", async () => {
    const s = start({
      northwind: stalled("northwind", "endo"),
      southwind: stalled("southwind", "endo"),
      eastwind: stalled("eastwind", "bido"),
    });
    await finishFirst(s);
    // An hour later endo has been idle 59 minutes: no idle hand-out, but the stall check is due.
    s.w.clock = NOON_KST + HOUR;
    const lines = await autopilotTick(s.d, s.launch);
    expect(lines[0]).toStartWith("[AUTOPILOT 완료] endo apple:");
    expect(s.launched.slice(1).map((l) => [l.bot, l.mission])).toEqual([
      ["bido", "autopilot-eastwind"],
      ["endo", "autopilot-northwind"],
    ]);
    expect(readState(s.home).stallReportedAt["southwind"]).toBeUndefined();
  });
});
