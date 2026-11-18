import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS } from "../src/autopilot.ts";
import { assignmentState, readAssignments } from "../src/autopilot-store.ts";
import { HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

const roadmap = (first: string) => `# 리포트\n- 담당: endo\n\n## 다음 할 일\n- [ ] ${first}\n- [ ] 두 번째 메모\n`;
const touch = (file: string, at: number) => {
  writeFileSync(file, "결과");
  utimesSync(file, at / 1000, at / 1000);
};

/** Pass 1 hands endo the first task at noon; its run ends `outcome` at 12:01, then pass 2 runs at `secondAt`. */
async function finish(first: (out: string) => string, prep: (out: string) => void, outcome = "ok", secondAt = 0) {
  const s = setup({}, HOUR, ["endo"]);
  const out = join(s.home, "out");
  mkdirSync(out);
  const file = join(s.home, "projects", "rep.md");
  writeFileSync(file, roadmap(first(out)));
  await autopilotTick(s.d, s.launch);
  expect(s.launched).toHaveLength(1);
  s.run("endo", NOON_KST + 30_000, NOON_KST + 60_000, s.launched[0]!.text, outcome);
  prep(out);
  s.w.clock = secondAt || NOON_KST + IDLE_CHECK_MS;
  const lines = await autopilotTick(s.d, s.launch);
  return { ...s, file, out, lines, text: () => readFileSync(file, "utf8") };
}

describe("autopilot: a finished delegation's roadmap line is checked off only with its output", () => {
  test("verified_completion_checks_only_matching_task", async () => {
    const r = await finish(
      (out) => `조사 결과를 ${out}/a.md에 써줘`,
      (out) => touch(`${out}/a.md`, NOON_KST + 50_000),
    );
    expect(r.text()).toBe(roadmap(`조사 결과를 ${r.out}/a.md에 써줘`).replace("- [ ] 조사", "- [x] 조사"));
    expect(r.lines).toEqual([`[AUTOPILOT 완료] endo rep: 조사 결과를 ${r.out}/a.md에 써줘 -> [x] (${r.out}/a.md)`]);
    const all = readAssignments(r.home);
    expect(all.map((a) => a.kind)).toEqual(["delegate", "completed"]);
    const { held, releases } = assignmentState(all);
    expect(held.has(`rep:${all[0]!.task}`)).toBe(true);
    expect(releases.size).toBe(0);
    r.w.clock += IDLE_CHECK_MS;
    expect(await autopilotTick(r.d, r.launch)).toEqual([]);
    expect(readAssignments(r.home)).toHaveLength(2);
  });

  const korean: [string, (out: string) => string, string][] = [
    ["a Korean file name", (out) => `결과를 ${out}/보고서.md에 써줘`, "보고서.md"],
    ["a Korean directory, a two-syllable particle", (out) => `${out}/문서/a.md에서 읽고 정리`, "문서/a.md"],
  ];
  for (const [name, first, rel] of korean)
    test(`korean_path_is_one_path_without_its_particle: ${name}`, async () => {
      const r = await finish(first, (out) => {
        mkdirSync(join(out, "문서"));
        touch(join(out, rel), NOON_KST + 50_000);
      });
      expect(r.lines).toEqual([`[AUTOPILOT 완료] endo rep: ${first(r.out)} -> [x] (${r.out}/${rel})`]);
    });

  const unverified: [string, (out: string) => string, (out: string) => void, string?][] = [
    [
      "Korean right after Korean stays in the path",
      (out) => `${out}/보고서에 써줘`,
      (out) => touch(`${out}/보고서`, NOON_KST + 50_000),
    ],
    ["no path in the task", () => "조사 메모 초안", () => {}],
    ["the output is missing", (out) => `${out}/a.md에 써줘`, () => {}],
    ["the output predates the hand-out", (out) => `${out}/a.md에 써줘`, (out) => touch(`${out}/a.md`, NOON_KST - HOUR)],
    ["the path is a directory", (out) => `${out}에 써줘`, () => {}],
    ["another machine's file", (out) => `mac:${out}/a.md에 써줘`, (out) => touch(`${out}/a.md`, NOON_KST + 50_000)],
    [
      "one of two paths is stale",
      (out) => `${out}/in.md를 읽고 ${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/in.md`, NOON_KST - HOUR);
        touch(`${out}/a.md`, NOON_KST + 50_000);
      },
    ],
    ["the run failed", (out) => `${out}/a.md에 써줘`, (out) => touch(`${out}/a.md`, NOON_KST + 50_000), "failed"],
  ];
  for (const [name, first, prep, outcome] of unverified)
    test(`process_ok_without_verified_completion_stays_open: ${name}`, async () => {
      const r = await finish(first, prep, outcome);
      expect(r.text()).toBe(roadmap(first(r.out)));
      expect(r.lines.some((l) => l.includes("완료"))).toBe(false);
      expect(readAssignments(r.home).some((a) => a.kind === "completed")).toBe(false);
    });

  test("stale_or_foreign_attempt_cannot_check_off", async () => {
    const s = setup({}, HOUR, ["endo", "bido"]);
    const out = join(s.home, "a.md");
    const file = join(s.home, "projects", "rep.md");
    writeFileSync(file, roadmap(`${out}에 써줘`));
    await autopilotTick(s.d, s.launch);
    const tagged = s.launched[0]!.text;
    s.run("bido", NOON_KST + 30_000, NOON_KST + 60_000, tagged);
    s.run("endo", NOON_KST - 60_000, NOON_KST - 30_000, tagged);
    touch(out, NOON_KST + 50_000);
    s.w.clock = NOON_KST + IDLE_CHECK_MS;
    await autopilotTick(s.d, s.launch);
    expect(readFileSync(file, "utf8")).toBe(roadmap(`${out}에 써줘`));
  });

  test("an edited task line is a conflict, a line checked before the record is only recorded, a reopened one stays", async () => {
    const edited = await finish(
      (out) => `${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/a.md`, NOON_KST + 50_000);
        writeFileSync(join(out, "..", "projects", "rep.md"), roadmap(`${out}/a.md에 다시 써줘`));
      },
    );
    expect(edited.text()).toBe(roadmap(`${edited.out}/a.md에 다시 써줘`));
    expect(readAssignments(edited.home).map((a) => a.kind)).toEqual(["delegate"]);

    const r = await finish(
      (out) => `${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/a.md`, NOON_KST + 50_000);
        const f = join(out, "..", "projects", "rep.md");
        writeFileSync(f, readFileSync(f, "utf8").replace("[ ]", "[x]"));
      },
    );
    expect(r.lines).toEqual([]);
    expect(readAssignments(r.home).map((a) => a.kind)).toEqual(["delegate", "completed"]);
    writeFileSync(r.file, r.text().replace("[x]", "[ ]"));
    r.w.clock += 3 * HOUR;
    await autopilotTick(r.d, r.launch);
    expect(r.text()).toBe(roadmap(`${r.out}/a.md에 써줘`));
    expect(r.launched.map((l) => l.text.includes("두 번째 메모"))).toEqual([false, true]);
  });

  test("a failed check-off is told once per delegation and failure, and retried until it is written", async () => {
    let n = 0;
    const fail = () => {
      const e = new Error(`EACCES: permission denied, rename 'rep.md.${++n}.tmp'`);
      throw Object.assign(e, { code: "EACCES" });
    };
    let spy: ReturnType<typeof spyOn> | undefined;
    const r = await finish(
      (out) => `${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/a.md`, NOON_KST + 50_000);
        spy = spyOn(fs, "renameSync").mockImplementation(fail);
      },
    );
    const failures = (lines: string[]) => lines.filter((l) => l.startsWith("[AUTOPILOT 완료 실패]"));
    try {
      expect(failures(r.lines)).toEqual([
        `[AUTOPILOT 완료 실패] endo rep: ${r.out}/a.md에 써줘 (EACCES: permission denied, rename 'rep.md.1.tmp')`,
      ]);
      r.w.clock += IDLE_CHECK_MS;
      expect(failures(await autopilotTick(r.d, r.launch))).toEqual([]);
      expect(n).toBe(2);
    } finally {
      spy?.mockRestore();
    }
    expect(r.text()).toBe(roadmap(`${r.out}/a.md에 써줘`));
    expect(readdirSync(join(r.home, "projects"))).toEqual(["rep.md"]);
    r.w.clock += IDLE_CHECK_MS;
    expect((await autopilotTick(r.d, r.launch))[0]).toStartWith("[AUTOPILOT 완료] endo rep:");
    expect(r.text()).toBe(roadmap(`${r.out}/a.md에 써줘`).replace("[ ]", "[x]"));
  });

  test("same_tick_uses_fresh_roadmap_without_resetting_idle_clock", async () => {
    const r = await finish(
      (out) => `${out}/a.md에 써줘`,
      (out) => touch(`${out}/a.md`, NOON_KST + 50_000),
      "ok",
      NOON_KST + 3 * HOUR,
    );
    expect(r.lines[0]).toStartWith("[AUTOPILOT 완료] endo rep:");
    expect(r.lines[1]).toBe("[AUTOPILOT] 유휴 봇 배정: endo 유휴(2시간) -> rep: 두 번째 메모");
    expect(r.launched).toHaveLength(2);
    const status = JSON.parse(readFileSync(join(r.home, "autopilot", "status.json"), "utf8"));
    expect(status.projects[0].tasks.map((t: { done: boolean }) => t.done)).toEqual([true, false]);
  });
});
