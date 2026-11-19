import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotTick, IDLE_CHECK_MS } from "../src/autopilot.ts";
import { REMOTE_CHECK_MS } from "../src/autopilot-remote.ts";
import { readAssignments } from "../src/autopilot-store.ts";
import { shq } from "../src/delivery.ts";
import type { ExecOptions, ExecResult } from "../src/runtime/exec.ts";
import { HOUR, NOON_KST, setup } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);
afterEach(() => jest.useRealTimers());

type Ssh = (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
const roadmap = (owner: string, task: string) => `# ${owner}\n- 담당: ${owner}\n\n## 다음 할 일\n- [ ] ${task}\n`;
const touch = (file: string, at: number) => {
  writeFileSync(file, "결과");
  utimesSync(file, at / 1000, at / 1000);
};
const answer = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });
const sec = (ms: number) => Math.floor(ms / 1000);

/**
 * Pass 1 hands each bot (name -> ssh host, "" for this machine) its project's one task at noon; every run ends ok at
 * 12:01. `ssh` answers the probes of pass 2, which runs at 12:10 after `prep`.
 */
function world(bots: Record<string, string>, task: (out: string, bot: string) => string, ssh: Ssh) {
  const s = setup({}, HOUR, Object.keys(bots));
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify(
      Object.entries(bots).map(([name, host]) => ({ name, host, profile: name, role: "", description: "" })),
    ),
  );
  const out = join(s.home, ".dori", "out");
  mkdirSync(out, { recursive: true });
  const file = (bot: string) => join(s.home, "projects", `${bot}.md`);
  for (const bot of Object.keys(bots)) writeFileSync(file(bot), roadmap(bot, task(out, bot)));
  const calls: string[][] = [];
  const d = {
    ...s.d,
    exec: (cmd: string, argv: readonly string[], options?: ExecOptions) => {
      if (cmd !== "ssh") return s.d.exec(cmd, argv, options);
      calls.push([...argv]);
      return ssh(argv, options);
    },
  };
  const pass1 = async () => {
    await autopilotTick(d, s.launch);
    expect(s.launched).toHaveLength(Object.keys(bots).length);
    for (const l of s.launched) s.run(l.bot, NOON_KST + 30_000, NOON_KST + 60_000, l.text);
    s.w.clock = NOON_KST + IDLE_CHECK_MS;
  };
  const text = (bot: string) => readFileSync(file(bot), "utf8");
  const kinds = () => readAssignments(s.home).map((a) => `${a.bot} ${a.kind}`);
  return { ...s, d, out, calls, file, pass1, text, kinds, pass2: () => autopilotTick(d, s.launch) };
}

describe("autopilot check-off: outputs on another machine are read over ssh", () => {
  test("local_output_checks_off_without_ssh", async () => {
    const w = world(
      { endo: "" },
      (out) => `${out}/a.md에 써줘`,
      async () => answer(""),
    );
    await w.pass1();
    touch(`${w.out}/a.md`, NOON_KST);
    const lines = await w.pass2();
    expect(w.text("endo")).toBe(roadmap("endo", `${w.out}/a.md에 써줘`).replace("- [ ] ", "- [x] "));
    expect(w.kinds()).toEqual(["endo delegate", "endo completed"]);
    expect(lines.filter((l) => l.startsWith("[AUTOPILOT 완료]"))).toHaveLength(1);
    expect(w.calls).toHaveLength(0);
  });

  const fresh = `ok ${sec(NOON_KST) + 50}`;
  const variants: [string, string, boolean][] = [
    ["both outputs fresh", `${fresh}\n${fresh}\n`, true],
    ["one output missing", `${fresh}\nno\n`, false],
    ["one output older than the hand-out", `${fresh}\nok ${sec(NOON_KST) - 1}\n`, false],
    ["one output a directory (the probe answers no)", `no\n${fresh}\n`, false],
    ["an answer line missing", `${fresh}\n`, false],
  ];
  const machines: [string, string][] = [
    ["ubuntu", "bot@ubuntu-box"],
    ["mac", "mac@mac-mini"],
  ];
  for (const [machine, host] of machines)
    for (const [name, stdout, checked] of variants)
      test(`remote_check_batches_all_selected_outputs: ${machine}, ${name}`, async () => {
        const task = (out: string) => `${out}/in.md를 읽고 ${out}/a.md에 쓰고 ${out}/b.md에 저장`;
        const w = world({ hongbungi: host }, task, async () => answer(stdout));
        await w.pass1();
        // This machine has every file, fresh: a remote bot's check must not use them.
        touch(`${w.out}/in.md`, NOON_KST - HOUR);
        touch(`${w.out}/a.md`, NOON_KST + 50_000);
        touch(`${w.out}/b.md`, NOON_KST + 50_000);
        const lines = await w.pass2();
        expect(w.calls).toHaveLength(1);
        const argv = w.calls[0]!;
        expect(argv.slice(0, 5)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", host]);
        expect(argv[5]!.endsWith(` sh ${shq(`${w.out}/a.md`)} ${shq(`${w.out}/b.md`)}`)).toBe(true);
        expect(argv[5]).not.toContain("in.md");
        const open = roadmap("hongbungi", task(w.out));
        expect(w.text("hongbungi")).toBe(checked ? open.replace("- [ ] ", "- [x] ") : open);
        expect(w.kinds()).toEqual(["hongbungi delegate", ...(checked ? ["hongbungi completed"] : [])]);
        expect(lines.some((l) => l.includes("완료"))).toBe(checked);
      });

  test("remote_check_never_runs_for_a_path_outside_its_out_dir: the whole task is held", async () => {
    const task = (out: string) => `${out}/a.md에 쓰고 ~/notes/b.md에 저장`;
    const w = world({ hongbungi: "bot@ubuntu-box" }, task, async () => answer("ok 1\nok 1\n"));
    await w.pass1();
    await w.pass2();
    expect(w.calls).toHaveLength(0);
    expect(w.text("hongbungi")).toBe(roadmap("hongbungi", task(w.out)));
  });
});

describe("autopilot check-off: the newest hand-out is checked first", () => {
  test("recent_remote_assignment_is_checked_before_old_backlog_spends_budget", async () => {
    const bots = { old1: "bot@old1", old2: "bot@old2", old3: "bot@old3", fresh: "bot@fresh" };
    const task = (out: string, bot: string) => `${out}/${bot}.md에 써줘`;
    let ssh: Ssh = async () => answer("no\n");
    const w = world(bots, task, (argv, options) => ssh(argv, options));
    const freshTask = task(w.out, "fresh");
    // Noon: only the old bots have a task. Their runs end ok, and pass 2 finds their outputs missing (held, no release).
    writeFileSync(w.file("fresh"), roadmap("fresh", freshTask).replace("- [ ] ", "- [x] "));
    await autopilotTick(w.d, w.launch);
    expect(w.launched.map((l) => l.bot)).toEqual(["old1", "old2", "old3"]);
    for (const l of w.launched) w.run(l.bot, NOON_KST + 30_000, NOON_KST + 60_000, l.text);
    writeFileSync(w.file("fresh"), roadmap("fresh", freshTask));
    w.w.clock = NOON_KST + IDLE_CHECK_MS;
    await w.pass2();
    expect(w.launched.map((l) => l.bot)).toEqual(["old1", "old2", "old3", "fresh"]);
    w.run("fresh", w.w.clock + 30_000, w.w.clock + 60_000, w.launched[3]!.text);
    expect(w.kinds()).toEqual(["old1 delegate", "old2 delegate", "old3 delegate", "fresh delegate"]);

    // Pass 3: the fresh bot answers at once; an old bot never does and spends the whole budget.
    jest.useFakeTimers();
    w.calls.length = 0;
    let started!: () => void;
    const stuck = new Promise<void>((r) => (started = r));
    let killed = 0;
    ssh = async (argv, options) => {
      if (argv[4] === "bot@fresh") return answer(`ok ${sec(w.w.clock)}\n`);
      options?.onSpawn?.({ kill: () => killed++ });
      started();
      return new Promise<ExecResult>(() => {});
    };
    w.w.clock += IDLE_CHECK_MS;
    const pass = w.pass2();
    await stuck;
    jest.advanceTimersByTime(REMOTE_CHECK_MS);
    const lines = await pass;

    expect(w.calls.map((c) => c[4])).toEqual(["bot@fresh", "bot@old1"]);
    expect(killed).toBe(1);
    expect(w.text("fresh")).toBe(roadmap("fresh", freshTask).replace("- [ ] ", "- [x] "));
    for (const bot of ["old1", "old2", "old3"]) expect(w.text(bot)).toBe(roadmap(bot, task(w.out, bot)));
    expect(w.kinds().slice(4)).toEqual(["fresh completed"]);
    expect(lines.filter((l) => l.includes("완료"))).toEqual([expect.stringContaining("fresh")]);
    expect(lines.some((l) => l.includes("[AUTOPILOT 실패]"))).toBe(false);
  });
});

describe("autopilot check-off: a remote check that fails holds the task and the pass goes on", () => {
  const bots = { appminhee: "mac@mac-mini", hongbungi: "bot@ubuntu-box", endo: "", gibungi: "" };
  const task = (out: string, bot: string) => (bot === "gibungi" ? "첫 메모" : `${out}/${bot}.md에 써줘`);

  /** After a failed probe: nothing remote checked off, endo's local line is, and idle gibungi gets its new task. */
  async function heldAndGoesOn(w: ReturnType<typeof world>, lines: string[]) {
    for (const bot of ["appminhee", "hongbungi"]) expect(w.text(bot)).toBe(roadmap(bot, task(w.out, bot)));
    expect(w.text("endo")).toBe(roadmap("endo", task(w.out, "endo")).replace("- [ ] ", "- [x] "));
    const after = w.kinds().slice(4);
    expect(after).toContain("endo completed");
    expect(after.filter((k) => k.startsWith("appminhee") || k.startsWith("hongbungi"))).toEqual([]);
    expect(lines.filter((l) => l.includes("완료"))).toEqual([expect.stringContaining("endo")]);
    expect(lines.some((l) => l.includes("[AUTOPILOT 실패]"))).toBe(false);
    expect(w.launched.at(-1)).toMatchObject({ bot: "gibungi" });
    expect(w.launched.at(-1)!.text).toContain("두 번째");
  }

  /** gibungi's done task gets a second one, so the pass that follows the probe has a hand-out to make. */
  async function prep(w: ReturnType<typeof world>) {
    await w.pass1();
    writeFileSync(
      w.file("gibungi"),
      `${roadmap("gibungi", task(w.out, "gibungi")).replace("- [ ] ", "- [x] ")}- [ ] 두 번째 메모\n`,
    );
    w.w.clock = NOON_KST + 3 * HOUR;
    for (const bot of ["appminhee", "hongbungi", "endo"]) touch(`${w.out}/${bot}.md`, NOON_KST + 50_000);
  }

  test("remote_probe_failure_leaves_task_held_and_duty_continues: ssh exits non-zero", async () => {
    const w = world(bots, task, async () => answer("", 255));
    await prep(w);
    const lines = await w.pass2();
    expect(w.calls).toHaveLength(2);
    await heldAndGoesOn(w, lines);
  });

  test("remote_probe_failure_leaves_task_held_and_duty_continues: ssh never answers", async () => {
    jest.useFakeTimers();
    let started!: () => void;
    const spawned = new Promise<void>((r) => (started = r));
    let killed = 0;
    let late!: (r: ExecResult) => void;
    const ssh: Ssh = (_argv, options) => {
      options?.onSpawn?.({ kill: () => killed++ });
      started();
      return new Promise((r) => (late = r));
    };
    const w = world(bots, task, ssh);
    await prep(w);
    const pass = w.pass2();
    await spawned;
    jest.advanceTimersByTime(REMOTE_CHECK_MS);
    const lines = await pass;
    expect(killed).toBe(1);
    expect(w.calls).toHaveLength(1);
    await heldAndGoesOn(w, lines);
    late(answer(`ok ${sec(NOON_KST) + 50}\n`));
    await Promise.resolve();
    for (const bot of ["appminhee", "hongbungi"]) expect(w.text(bot)).toBe(roadmap(bot, task(w.out, bot)));
  });
});
