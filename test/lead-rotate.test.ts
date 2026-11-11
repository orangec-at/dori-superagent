import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { hooksSettled } from "../src/hooks.ts";
import { send } from "../src/inbox.ts";
import { contextTokens, leadRotationTick, QUIET_MS, rotationDue } from "../src/lead-rotate.ts";
import { LEAD_ROTATION_DEFAULTS, loadLeadRotation, readRotation, rotationLog } from "../src/lead-rotate-state.ts";
import { setup } from "./harness-setup.ts";
import { href } from "./fake.ts";

const footer = (used: string) =>
  `${"─".repeat(20)}\n❯\n${"─".repeat(20)}\n~/workspace • main • ${used}/1M (35.0%) (auto)\n`;

const BUSY = "Working... (esc to interrupt)\n";

function rig(config: object = {}) {
  const s = setup();
  writeFileSync(
    join(s.d.store.root, "config.json"),
    JSON.stringify({ hooks: { onLeadRotation: ["notify", "{text}"] }, ...config }),
  );
  const notified: string[] = [];
  s.w.reviewer = (argv) => {
    notified.push(argv.join(" "));
    return { code: 0, stdout: "" };
  };
  const killed: number[] = [];
  const procs = { kill: (pid: number) => void killed.push(pid), alive: () => false, sleep: async () => {} };
  return { ...s, notified, killed, procs };
}

const handoffFile = (text: string): string => /(\/\S+\.md)/.exec(text)?.[1] ?? "";

describe("lead rotation (#8)", () => {
  test("reads omo's footer and decides by tokens or age, with config overrides", () => {
    expect(contextTokens(`noise 1/2 (3)\n${footer("638K")}`)).toBe(638_000);
    expect(contextTokens("~/x • 1.2M/2M (60.0%) (auto)")).toBe(1_200_000);
    expect(contextTokens("no footer here, 12/40 tests")).toBeUndefined();
    const c = LEAD_ROTATION_DEFAULTS;
    const h = 3_600_000;
    expect(rotationDue(c, { ref: "w1:p1", startedAt: 0, tokens: 299_000 }, 23 * h)).toBeUndefined();
    expect(rotationDue(c, { ref: "w1:p1", startedAt: 0, tokens: 300_000 }, 0)).toBe("context 300K >= 300K");
    expect(rotationDue(c, { ref: "w1:p1", startedAt: 0 }, 25 * h)).toBe("session 25h old >= 24h");
    const { d } = rig({ leadRotation: { maxTokens: 500_000, auto: false } });
    expect(loadLeadRotation(d.store.root)).toEqual({ ...c, maxTokens: 500_000, auto: false });
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ leadRotation: { maxHours: -1 } }));
    expect(() => loadLeadRotation(d.store.root)).toThrow("leadRotation.maxHours must be a positive number");
  });

  test("over the limit and idle: handoff asked, inbox held, new session started with it, queue kept for it", async () => {
    const { w, d, lead, notified, killed, procs } = rig();
    lead.screen = `${BUSY}${footer("350K")}`;
    lead.status = "working";
    expect(await leadRotationTick(d, procs)).toEqual([]);
    lead.status = "idle";
    lead.screen = footer("350K");
    const [asked] = await leadRotationTick(d, procs);
    expect(asked).toMatchObject({ pane: "w1:p1", action: "lead-handoff-requested" });
    expect(lead.received.at(-1)).toContain("인수인계 문서를");
    const file = handoffFile(lead.received.at(-1)!);
    expect(file).toStartWith(join(d.store.root, "handoff"));

    // While the lead writes its handoff nothing reaches it, from any sender, even when it is idle.
    expect(await send(d, "lead", "a lane reported meanwhile", "dori-3")).toBe("QUEUED");
    expect(await leadRotationTick(d, procs)).toEqual([]);
    expect(killed).toEqual([]);

    writeFileSync(file, "# handoff\n- dori-3 PR #20 waits for review\n");
    w.clock += 60_000;
    const [rotated] = await leadRotationTick(d, procs);
    expect(rotated).toMatchObject({ pane: "w1:p1", action: "lead-rotated" });
    expect(killed).toEqual([101]);
    expect(lead.ran).toHaveLength(1);
    expect(lead.ran[0]).toStartWith("omo --append-system-prompt ");
    expect(lead.ran[0]).toContain(`cat '${file}'`);
    expect(readRotation(d.store.root)).toBeUndefined();
    expect(d.store.roles().lead).toEqual(href("w1:p1"));
    expect(d.store.queued(href("w1:p1")).map((m) => m.text)).toEqual(["a lane reported meanwhile"]);
    expect(readFileSync(rotationLog(d.store.root), "utf8")).toContain("[LEAD ROTATED] w1:p1: context 350K >= 300K");
    await hooksSettled();
    expect(notified).toEqual([expect.stringContaining("[LEAD ROTATED] w1:p1: context 350K")]);

    // The new session gets the held queue; its old footer still on screen does not start another rotation.
    lead.received.length = 0;
    expect(await dutyTick(d)).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toEqual(["a lane reported meanwhile"]);
    expect(lead.ran).toHaveLength(1);
  });

  test("no handoff in time: the rotation is given up, the lead keeps its session and gets its queue", async () => {
    const { w, d, lead, killed, procs, notified } = rig();
    lead.screen = footer("400K");
    const [asked] = await leadRotationTick(d, procs);
    expect(asked?.action).toBe("lead-handoff-requested");
    const file = handoffFile(lead.received.at(-1)!);
    expect(await send(d, "lead", "queued during the wait", "cli")).toBe("QUEUED");
    w.clock += 14 * 60_000;
    expect(await leadRotationTick(d, procs)).toEqual([]);
    w.clock += 60_000;
    const [timeout] = await leadRotationTick(d, procs);
    expect(timeout).toMatchObject({ pane: "w1:p1", action: "lead-rotate-timeout" });
    expect(killed).toEqual([]);
    expect(lead.ran).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(lead.received.at(-1)).toContain("queued during the wait");
    expect(lead.received.at(-1)).toContain("[LEAD ROTATE TIMEOUT] w1:p1");
    expect(d.store.queued(href("w1:p1"))).toEqual([]);
    await hooksSettled();
    expect(notified).toEqual([expect.stringContaining("[LEAD ROTATE TIMEOUT]")]);

    // No new request before the quiet time is over, then the next one.
    w.clock += QUIET_MS - 60_000;
    expect(await leadRotationTick(d, procs)).toEqual([]);
    w.clock += 60_000;
    expect((await leadRotationTick(d, procs))[0]?.action).toBe("lead-handoff-requested");
  });

  test("dori lead rotate --now works with auto off and waits for an idle lead; auto off rotates nothing by itself", async () => {
    const { d, lead, procs } = rig({ leadRotation: { auto: false } });
    lead.screen = footer("900K");
    expect(await leadRotationTick(d, procs)).toEqual([]);
    lead.status = "working";
    lead.screen = `${BUSY}${footer("900K")}`;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["lead", "rotate", "--now"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("LEAD_ROTATE_DUE");
    expect(lead.received).toEqual([]);
    expect(await leadRotationTick(d, procs)).toEqual([]);
    lead.status = "idle";
    lead.screen = footer("900K");
    const [asked] = await leadRotationTick(d, procs);
    expect(asked).toMatchObject({ action: "lead-handoff-requested" });
    expect(asked?.detail).toStartWith("dori lead rotate --now");
    await expect(main(["lead", "rotate"], d)).rejects.toThrow("usage: dori lead rotate --now");
  });
});
