import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS } from "../src/autopilot.ts";
import { readAssignments } from "../src/autopilot-store.ts";
import { HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

const roadmap = (first: string) => `# 리포트\n- 담당: endo\n\n## 다음 할 일\n- [ ] ${first}\n- [ ] 두 번째 메모\n`;
const touch = (file: string, at: number) => {
  writeFileSync(file, "결과");
  utimesSync(file, at / 1000, at / 1000);
};
const STALE = NOON_KST - HOUR;
const FRESH = NOON_KST + 50_000;

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

/** Inputs (`in*.md`) stale, `res.md` fresh. */
const inputsStaleOutputFresh = (out: string) => {
  for (const f of ["in.md", "in1.md", "in2.md", "tpl.md"]) touch(`${out}/${f}`, STALE);
  touch(`${out}/res.md`, FRESH);
};

describe("autopilot check-off: output markers with words between the particle and the verb", () => {
  // overlap-check 3절 T1: step2의 WRITES_TO는 아래 세 문장(로드맵에 실제로 쓰는 말투)을 출력 표시로 보지 못했다.
  const marked: [string, (out: string) => string][] = [
    ["에 표로 써줘", (o) => `${o}/in1.md와 ${o}/in2.md를 대조해 ${o}/res.md에 표로 써줘`],
    ["에 한국어로 정리", (o) => `${o}/in.md를 읽고 ${o}/res.md에 한국어로 정리`],
    ["로 저장", (o) => `${o}/in.md를 읽고 결과를 ${o}/res.md로 저장`],
    ["에 짧게 정리해줘", (o) => `${o}/in.md를 ${o}/res.md에 짧게 정리해줘`],
    ["에 한국어로 그대로 써줘 (two modifiers)", (o) => `${o}/in.md를 ${o}/res.md에 한국어로 그대로 써줘`],
    ["에 써 줘 (a space inside the verb)", (o) => `${o}/in.md를 읽고 ${o}/res.md에 써 줘`],
    ["파일에 써줘", (o) => `${o}/in.md를 읽고 ${o}/res.md 파일에 써줘`],
    ["파일로 저장", (o) => `${o}/in.md 요약을 ${o}/res.md 파일로 저장`],
    ["에 있는 (not a marker) before the output", (o) => `${o}/in.md에 있는 표를 ${o}/res.md에 써줘`],
    ["에 쓰지 말고 (negated) before the output", (o) => `${o}/in.md에 쓰지 말고 ${o}/res.md에 써줘`],
    [
      "the overlap-check roadmap line (27)",
      (o) =>
        `${o}/in1.md와 ${o}/in2.md 두 초안을 ${o}/tpl.md와 대조해, 서로 같은 함수·파일을 다르게 고치는 곳을 ${o}/res.md에 표로 써줘(저장소는 읽기만, 코드 수정·커밋·PR 금지)`,
    ],
    [
      "the step3 roadmap line itself",
      (o) =>
        `${o}/in.md 3절 T1의 빈칸('에 표로 써줘', '로 저장')을 메우는 초안을 ${o}/res.md에 써줘: src/autopilot-checkoff.ts에 넣을 diff(저장소는 읽기만)`,
    ],
  ];
  for (const [name, first] of marked)
    test(`marked_output_is_the_only_path_that_must_be_fresh: ${name}`, async () => {
      const r = await finish(first, inputsStaleOutputFresh);
      expect(r.text()).toBe(roadmap(first(r.out)).replace("- [ ] ", "- [x] "));
      expect(r.lines[0]).toBe(`[AUTOPILOT 완료] endo rep: ${first(r.out)} -> [x] (${r.out}/res.md)`);
      expect(readAssignments(r.home).map((a) => a.kind)).toEqual(["delegate", "completed"]);
    });

  // 틀려도 "체크 안 됨" 쪽으로만 틀리는지 고정한다.
  const open: [string, (out: string) => string, (out: string) => void][] = [
    [
      "the marked output is stale though the input is fresh",
      (o) => `${o}/in.md를 읽고 ${o}/res.md에 표로 써줘`,
      (o) => {
        touch(`${o}/in.md`, FRESH);
        touch(`${o}/res.md`, STALE);
      },
    ],
    [
      "the 로-marked output is missing",
      (o) => `${o}/in.md를 읽고 결과를 ${o}/res.md로 저장`,
      (o) => touch(`${o}/in.md`, STALE),
    ],
    [
      "로 with a verb that does not write marks nothing, so the stale template blocks",
      (o) => `${o}/tpl.md로 시작해 ${o}/res.md를 채워`,
      inputsStaleOutputFresh,
    ],
    [
      "a modifier that is not …로/…게 marks nothing, so the stale input blocks",
      (o) => `${o}/in.md를 ${o}/res.md에 한 줄 써줘`,
      inputsStaleOutputFresh,
    ],
    [
      "에 쓰인 (used in) marks the input too: fail closed",
      (o) => `${o}/in.md에 쓰인 규칙대로 ${o}/res.md에 정리`,
      inputsStaleOutputFresh,
    ],
  ];
  for (const [name, first, prep] of open)
    test(`unmarked_or_stale_output_stays_open: ${name}`, async () => {
      const r = await finish(first, prep);
      expect(r.text()).toBe(roadmap(first(r.out)));
      expect(r.lines.some((l) => l.includes("완료"))).toBe(false);
      expect(readAssignments(r.home).some((a) => a.kind === "completed")).toBe(false);
    });
});
