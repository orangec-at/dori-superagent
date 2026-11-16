import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS, startDelegate } from "../src/autopilot.ts";
import { readAssignments } from "../src/autopilot-store.ts";
import { COUPAS, HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

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
