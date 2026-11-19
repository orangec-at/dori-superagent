import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS, quietHour, startDelegate } from "../src/autopilot.ts";
import { readAssignments } from "../src/autopilot-store.ts";
import { taskId } from "../src/roadmap.ts";
import { COUPAS, HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

const THREE_AM_KST = Date.parse("2026-11-16T18:00:00Z");

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

  test("by default it runs around the clock: 03:00 KST still hands out work", async () => {
    const { d, launched, launch, w } = setup({ coupas: COUPAS }, HOUR, ["hongbungi"]);
    w.clock = THREE_AM_KST;
    await autopilotTick(d, launch);
    expect(launched.map((l) => l.bot)).toEqual(["hongbungi"]);
  });

  test("DORI_QUIET_HOURS: off/none/empty never rest, A-B rests A:00-B:00 KST (wrapping), anything else means 1-8", () => {
    const at = (h: number) => Date.parse(`2026-11-16T${String((h + 15) % 24).padStart(2, "0")}:00:00Z`);
    const quiet = (v: string) => {
      process.env["DORI_QUIET_HOURS"] = v;
      return [0, 1, 3, 7, 8, 12, 22, 23].filter((h) => quietHour(at(h)));
    };
    expect([0, 3, 12].filter((h) => quietHour(at(h)))).toEqual([]);
    for (const v of ["off", "none", "", " OFF "]) expect(quiet(v)).toEqual([]);
    expect(quiet("1-8")).toEqual([1, 3, 7]);
    expect(quiet("22-6")).toEqual([0, 1, 3, 22, 23]);
    for (const bad of ["1to8", "25-3", "5-5", "-1-8", "night"]) expect(quiet(bad)).toEqual([1, 3, 7]);
  });

  test("DORI_QUIET_HOURS=1-8 hands out nothing at 03:00 KST; the stop file turns the autopilot off", async () => {
    process.env["DORI_QUIET_HOURS"] = "1-8";
    const { d, home, launched, launch, w } = setup({ coupas: COUPAS });
    w.clock = THREE_AM_KST;
    expect(await autopilotTick(d, launch)).toEqual([]);
    w.clock = NOON_KST;
    mkdirSync(join(home, "autopilot"), { recursive: true });
    writeFileSync(join(home, "autopilot", "stop"), "");
    expect(await autopilotTick(d, launch)).toEqual([]);
    expect(launched).toEqual([]);
  });
});

describe("autopilot: an idle bot with nothing to hand out is reported to the lead", () => {
  test("reported once, not again within a day, and handed the task once the roadmap has one", async () => {
    const EMPTY = "# 빈 프로젝트\n- 담당: hongbungi\n\n## 다음 할 일\n- [x] 끝난 일\n- [ ] 스레드에 게시\n";
    const { d, home, lead, launched, launch, run, w } = setup({ empty: EMPTY }, HOUR, ["hongbungi"]);
    run("hongbungi", NOON_KST - 14 * HOUR, NOON_KST - 13 * HOUR);
    const file = join(home, "projects", "empty.md");
    const report = `[REPORT autopilot] hongbungi 유휴 13시간: 맡길 일 없음 → ${file}에 추가해 주세요`;
    expect(await autopilotTick(d, launch)).toEqual([report]);
    expect(lead.received.join("\n")).toContain(report);
    const reports = async () => (await autopilotTick(d, launch)).filter((l) => l.startsWith("[REPORT autopilot]"));

    w.clock += IDLE_CHECK_MS;
    expect(await reports()).toEqual([]);
    w.clock = NOON_KST + 23 * HOUR;
    expect(await reports()).toEqual([]);
    w.clock = NOON_KST + 24 * HOUR;
    expect(await reports()).toEqual([report.replace("13시간", "37시간")]);
    expect(launched).toEqual([]);

    writeFileSync(file, `${EMPTY}- [ ] 다음 주 후보 초안\n`);
    w.clock += IDLE_CHECK_MS;
    const lines = await autopilotTick(d, launch);
    expect(lines.filter((l) => l.startsWith("[REPORT autopilot]"))).toEqual([]);
    expect(lines).toContain("[AUTOPILOT] 유휴 봇 배정: hongbungi 유휴(37시간) -> empty: 다음 주 후보 초안");
    expect(launched.map((l) => l.bot)).toEqual(["hongbungi"]);
  });
});

describe("autopilot: a delegation that fails is released and handed out again", () => {
  test("a failed delegation is told to the lead and reassigned; the second failure holds the task", async () => {
    const { d, home, launched, launch, run, w } = setup({ coupas: COUPAS }, HOUR, ["hongbungi"]);
    await autopilotTick(d, launch);
    const first = readAssignments(home)[0]!;
    const tag = launched[0]!.text.split(" ").slice(0, 3).join(" ");
    expect(tag).toBe(`[autopilot coupas ${first.task}]`);
    run("hongbungi", NOON_KST + 1000, NOON_KST + 2000, launched[0]!.text, "failed");
    w.clock += IDLE_CHECK_MS;
    const lines = await autopilotTick(d, launch);
    expect(lines[0]).toBe(`[AUTOPILOT 실패] hongbungi coupas: ${first.text} (failed) -> 다시 배정 대기`);
    w.clock = NOON_KST + 3 * HOUR;
    await autopilotTick(d, launch);
    expect(launched.map((l) => l.text)).toEqual([launched[0]!.text, launched[0]!.text]);
    run("hongbungi", w.clock + 1000, w.clock + 2000, launched[0]!.text, "timeout");
    w.clock += IDLE_CHECK_MS;
    expect((await autopilotTick(d, launch))[0]).toContain("(timeout) -> 2번 실패해 멈춤");
    w.clock += 3 * HOUR;
    await autopilotTick(d, launch);
    expect(launched).toHaveLength(2);
  });

  test("an edited line after two failures is a new task, handed out once its bot is idle again; a health check restarts the wait", async () => {
    const { d, home, launched, launch, run, w } = setup({ coupas: COUPAS }, HOUR, ["hongbungi"]);
    await autopilotTick(d, launch);
    const old = readAssignments(home)[0]!.task;
    run("hongbungi", NOON_KST + 1000, NOON_KST + 2000, launched[0]!.text, "failed");
    w.clock += IDLE_CHECK_MS;
    await autopilotTick(d, launch);
    w.clock = NOON_KST + 3 * HOUR;
    await autopilotTick(d, launch);
    run("hongbungi", w.clock + 1000, w.clock + 2000, launched[1]!.text, "failed");
    w.clock += IDLE_CHECK_MS;
    expect((await autopilotTick(d, launch))[0]).toContain("2번 실패해 멈춤");

    const edited = "다음 주 후보 6개 초안. 게시는 하지 마";
    writeFileSync(join(home, "projects", "coupas.md"), COUPAS.replace("다음 주 후보 5개 초안. 게시는 하지 마", edited));
    const fresh = taskId("coupas", edited);
    expect(fresh).not.toBe(old);
    expect(readAssignments(home).filter((a) => a.task === fresh)).toEqual([]);
    const checked = w.clock + 5000;
    run("hongbungi", w.clock, checked, "응답");

    w.clock = checked + 2 * HOUR - 10 * 60_000;
    await autopilotTick(d, launch);
    expect(launched).toHaveLength(2);
    w.clock = checked + 2 * HOUR + 10 * 60_000;
    await autopilotTick(d, launch);
    expect(launched).toHaveLength(3);
    expect(launched[2]!.text.startsWith(`[autopilot coupas ${fresh}]`)).toBe(true);
    expect(readAssignments(home).filter((a) => a.task === fresh && a.kind === "delegate")).toHaveLength(1);
  });

  test("a delegation that never started is released after 15 minutes", async () => {
    const { d, launch, w } = setup({ coupas: COUPAS }, HOUR, ["hongbungi"]);
    await autopilotTick(d, launch);
    w.clock += 20 * 60_000;
    expect((await autopilotTick(d, launch))[0]).toContain("(never started) -> 다시 배정 대기");
  });

  test("startDelegate runs dori delegate with the bot, text, timeout and mission as separate arguments", async () => {
    const { d, home } = setup({});
    const stub = join(home, "stub-cli.ts");
    writeFileSync(
      stub,
      `await Bun.write(process.env.DORI_HOME + "/argv.json", JSON.stringify(process.argv.slice(2)));\n`,
    );
    const child = startDelegate(d, "bido", "it's $HOME; rm -rf /", "autopilot-coupas", stub);
    await new Promise((resolve) => child.on("exit", resolve));
    expect(JSON.parse(readFileSync(join(home, "argv.json"), "utf8"))).toEqual([
      "delegate",
      "bido",
      "--text",
      "it's $HOME; rm -rf /",
      "--timeout",
      "1800",
      "--mission",
      "autopilot-coupas",
    ]);
  });
});
