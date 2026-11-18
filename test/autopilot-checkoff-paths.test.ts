import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS } from "../src/autopilot.ts";
import { readAssignments, readState } from "../src/autopilot-store.ts";
import { HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

const roadmap = (first: string) => `# 리포트\n- 담당: endo\n\n## 다음 할 일\n- [ ] ${first}\n- [ ] 두 번째 메모\n`;
const touch = (file: string, at: number) => {
  writeFileSync(file, "결과");
  utimesSync(file, at / 1000, at / 1000);
};

/** Pass 1 hands endo the first task at noon; its run ends ok at 12:01; `prep` lays out files; pass 2 runs. */
async function finish(first: (out: string) => string, prep: (out: string) => void) {
  const s = setup({}, HOUR, ["endo"]);
  const out = join(s.home, "out");
  mkdirSync(out);
  const file = join(s.home, "projects", "rep.md");
  writeFileSync(file, roadmap(first(out)));
  await autopilotTick(s.d, s.launch);
  expect(s.launched).toHaveLength(1);
  s.run("endo", NOON_KST + 30_000, NOON_KST + 60_000, s.launched[0]!.text);
  prep(out);
  s.w.clock = NOON_KST + IDLE_CHECK_MS;
  const lines = await autopilotTick(s.d, s.launch);
  return { ...s, file, out, lines, text: () => readFileSync(file, "utf8") };
}

describe("autopilot check-off: only the paths a task writes to must be fresh", () => {
  // 운영 근거(2026-11-18 assignments.jsonl): 입력 파일을 함께 적은 위임 4건은 ok로 끝났어도 completed가 없었다.
  const outputsOnly: [string, (out: string) => string, (out: string) => void, string][] = [
    [
      "a stale input before the output",
      (out) => `${out}/in.md를 읽고 ${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/in.md`, NOON_KST - HOUR);
        touch(`${out}/a.md`, NOON_KST + 50_000);
      },
      "a.md",
    ],
    [
      "an input before, another input in parentheses after the output",
      (out) => `${out}/plan.md 4절만 대상으로 초안을 ${out}/b.md에 써줘(${out}/step1.md와 겹치지 않게)`,
      (out) => {
        touch(`${out}/plan.md`, NOON_KST - 5 * HOUR);
        touch(`${out}/step1.md`, NOON_KST - 2 * HOUR);
        touch(`${out}/b.md`, NOON_KST + 50_000);
      },
      "b.md",
    ],
    [
      "저장 instead of 써줘",
      (out) => `${out}/in.md 요약을 ${out}/a.md에 저장`,
      (out) => {
        touch(`${out}/in.md`, NOON_KST - HOUR);
        touch(`${out}/a.md`, NOON_KST + 50_000);
      },
      "a.md",
    ],
  ];
  for (const [name, first, prep, rel] of outputsOnly)
    test(`named_inputs_do_not_block_a_fresh_output: ${name}`, async () => {
      const r = await finish(first, prep);
      expect(r.text()).toBe(roadmap(first(r.out)).replace("- [ ] ", "- [x] "));
      expect(r.lines[0]).toBe(`[AUTOPILOT 완료] endo rep: ${first(r.out)} -> [x] (${r.out}/${rel})`);
      expect(readAssignments(r.home).map((a) => a.kind)).toEqual(["delegate", "completed"]);
    });

  const outputNotFresh: [string, (out: string) => string, (out: string) => void][] = [
    [
      "the output is stale though the input is fresh",
      (out) => `${out}/in.md를 읽고 ${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/in.md`, NOON_KST + 50_000);
        touch(`${out}/a.md`, NOON_KST - HOUR);
      },
    ],
    [
      "one of two outputs is missing",
      (out) => `${out}/a.md에 쓰고 ${out}/b.md에 저장`,
      (out) => touch(`${out}/a.md`, NOON_KST + 50_000),
    ],
    ["the input and the output are both missing", (out) => `${out}/in.md를 읽고 ${out}/a.md에 써줘`, () => {}],
  ];
  for (const [name, first, prep] of outputNotFresh)
    test(`output_must_be_fresh_even_with_inputs: ${name}`, async () => {
      const r = await finish(first, prep);
      expect(r.text()).toBe(roadmap(first(r.out)));
      expect(r.lines.some((l) => l.includes("완료"))).toBe(false);
      expect(readAssignments(r.home).some((a) => a.kind === "completed")).toBe(false);
    });

  test("a completed record that fails after the write is recovered next pass without re-delegation", async () => {
    const s = setup({}, HOUR, ["endo"]);
    const out = join(s.home, "a.md");
    const file = join(s.home, "projects", "rep.md");
    writeFileSync(file, roadmap(`${out}에 써줘`));
    await autopilotTick(s.d, s.launch);
    s.run("endo", NOON_KST + 30_000, NOON_KST + 60_000, s.launched[0]!.text);
    touch(out, NOON_KST + 50_000);
    s.w.clock = NOON_KST + IDLE_CHECK_MS;
    const real = fs.appendFileSync;
    let failed = 0;
    const spy = spyOn(fs, "appendFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (failed === 0 && String(p).endsWith("assignments.jsonl")) {
        failed++;
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return (real as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.appendFileSync);
    try {
      await expect(autopilotTick(s.d, s.launch)).rejects.toThrow("ENOSPC");
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(roadmap(`${out}에 써줘`).replace("[ ]", "[x]"));
    expect(readAssignments(s.home).map((a) => a.kind)).toEqual(["delegate"]);
    s.w.clock += IDLE_CHECK_MS;
    // The line was checked already, so the recovering pass only records it: no second 완료 notice.
    expect((await autopilotTick(s.d, s.launch)).some((l) => l.startsWith("[AUTOPILOT 완료]"))).toBe(false);
    expect(readAssignments(s.home).filter((a) => a.kind === "completed")).toHaveLength(1);
    expect(s.launched.filter((l) => l.text.includes(`${out}에 써줘`))).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(roadmap(`${out}에 써줘`).replace("[ ]", "[x]"));
  });

  test("a held ok delegation whose line a person checked already is only recorded", async () => {
    // Delegations held before this rule (an input named with the output) are judged again; their lines are [x] already.
    const first = (out: string) => `${out}/in.md를 읽고 ${out}/a.md에 써줘`;
    const r = await finish(first, (out) => {
      touch(`${out}/in.md`, NOON_KST - HOUR);
      touch(`${out}/a.md`, NOON_KST + 50_000);
      writeFileSync(join(out, "..", "projects", "rep.md"), roadmap(first(out)).replace("- [ ] ", "- [x] "));
    });
    expect(r.lines).toEqual([]);
    expect(readAssignments(r.home).map((a) => a.kind)).toEqual(["delegate", "completed"]);
    r.w.clock += 3 * HOUR;
    await autopilotTick(r.d, r.launch);
    expect(r.launched.map((l) => l.text.includes("두 번째 메모"))).toEqual([false, true]);
  });

  test("a check-off that succeeds after a failure forgets the failure", async () => {
    let spy: ReturnType<typeof spyOn> | undefined;
    const r = await finish(
      (out) => `${out}/a.md에 써줘`,
      (out) => {
        touch(`${out}/a.md`, NOON_KST + 50_000);
        spy = spyOn(fs, "renameSync").mockImplementation(() => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        });
      },
    );
    spy?.mockRestore();
    expect(r.lines[0]).toStartWith("[AUTOPILOT 완료 실패]");
    expect(Object.keys(readState(r.home).checkOffFailed ?? {})).toHaveLength(1);
    r.w.clock += IDLE_CHECK_MS;
    expect((await autopilotTick(r.d, r.launch))[0]).toStartWith("[AUTOPILOT 완료] endo rep:");
    expect(readState(r.home).checkOffFailed ?? {}).toEqual({});
  });
});
