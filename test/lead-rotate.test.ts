import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { hooksSettled } from "../src/hooks.ts";
import { send } from "../src/inbox.ts";
import { BASELINE_MS, contextTokens, leadRotationTick, QUIET_MS, rotationDue } from "../src/lead-rotate.ts";
import {
  LEAD_ROTATION_DEFAULTS,
  loadLeadRotation,
  operationsPath,
  readRotation,
  readSession,
  rotationLog,
  writeSession,
} from "../src/lead-rotate-state.ts";
import { setup } from "./harness-setup.ts";
import { href } from "./fake.ts";

const footer = (used: string) =>
  `${"─".repeat(20)}\n❯\n${"─".repeat(20)}\n~/workspace • main • ${used}/1M (35.0%) (auto)\n`;

const BUSY = "Working... (esc to interrupt)\n";

/** `fresh`: the lead session is new to dori; otherwise it has been running for a while with a baseline of 0. */
function rig(config: object = {}, fresh = false) {
  const s = setup();
  writeFileSync(
    join(s.d.store.root, "config.json"),
    JSON.stringify({ hooks: { onLeadRotation: ["notify", "{text}"] }, leadRotation: { notify: "each" }, ...config }),
  );
  if (!fresh)
    writeSession(s.d.store.root, { ref: "w1:p1", startedAt: s.w.clock - BASELINE_MS, tokens: 1, baseTokens: 0 });
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
    // The limit counts growth over the session's baseline.
    expect(rotationDue(c, { ref: "w1:p1", startedAt: 0, tokens: 599_000, baseTokens: 336_000 }, h)).toBeUndefined();
    expect(rotationDue(c, { ref: "w1:p1", startedAt: 0, tokens: 640_000, baseTokens: 336_000 }, h)).toBe(
      "context 640K = start 336K + 304K >= +300K",
    );
    const { d } = rig({ leadRotation: { maxTokens: 500_000, auto: false } });
    expect(loadLeadRotation(d.store.root)).toEqual({ ...c, maxTokens: 500_000, auto: false });
    expect(c.notify).toBe("daily");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ leadRotation: { maxHours: -1 } }));
    expect(() => loadLeadRotation(d.store.root)).toThrow("leadRotation.maxHours must be a positive number");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ leadRotation: { notify: "dm" } }));
    expect(() => loadLeadRotation(d.store.root)).toThrow("leadRotation.notify must be one of each, daily, log");
  });

  test("a session that starts over the limit is rotated only after it grew by maxTokens past its baseline", async () => {
    const { w, d, lead, procs } = rig({}, true);
    // The old session's footer may still be on screen for the first pass; the last reading in the window counts.
    lead.screen = footer("640K");
    expect(await leadRotationTick(d, procs)).toEqual([]);
    w.clock += 60_000;
    lead.screen = footer("336K");
    expect(await leadRotationTick(d, procs)).toEqual([]);
    for (const used of ["340K", "345K", "500K", "630K"]) {
      w.clock += BASELINE_MS / 2;
      lead.screen = footer(used);
      expect(await leadRotationTick(d, procs)).toEqual([]);
    }
    expect(readSession(d.store.root)).toMatchObject({ baseTokens: 340_000, tokens: 630_000 });
    lead.screen = footer("640K");
    const [asked] = await leadRotationTick(d, procs);
    expect(asked).toMatchObject({ action: "lead-handoff-requested" });
    expect(asked?.detail).toStartWith("context 640K = start 340K + 300K >= +300K");
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
    expect(lead.ran[0]).toStartWith("ENABLE_CLAUDEAI_MCP_SERVERS=false omo --append-system-prompt ");
    expect(lead.ran[0]).toContain(`인수인계 문서(${file})`);
    expect(lead.ran[0]).not.toContain("$(");
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

  test("with leadModel the new lead session starts on that model", async () => {
    const { d, lead, procs } = rig({ leadModel: "anthropic-subscription/claude-fable-5-2" });
    lead.screen = footer("350K");
    await leadRotationTick(d, procs);
    writeFileSync(handoffFile(lead.received.at(-1)!), "# handoff\n");
    expect(await leadRotationTick(d, procs)).toMatchObject([{ action: "lead-rotated" }]);
    expect(lead.ran[0]).toStartWith(
      "ENABLE_CLAUDEAI_MCP_SERVERS=false omo --model 'anthropic-subscription/claude-fable-5-2' --append-system-prompt ",
    );
  });

  test("the request names the operations document, and the new session gets it after the handoff once it exists", async () => {
    const { w, d, lead, procs } = rig();
    const ops = operationsPath(d.store.root);
    lead.screen = footer("350K");
    await leadRotationTick(d, procs);
    expect(lead.received.at(-1)).toContain(ops);
    writeFileSync(handoffFile(lead.received.at(-1)!), "# handoff\n");
    await leadRotationTick(d, procs);
    expect(lead.ran[0]).not.toContain(ops);

    lead.screen = footer("20K");
    await leadRotationTick(d, procs);
    w.clock += QUIET_MS;
    writeFileSync(ops, "# operations\n");
    lead.screen = footer("360K");
    await leadRotationTick(d, procs);
    const file = handoffFile(lead.received.at(-1)!);
    writeFileSync(file, "# handoff\n");
    expect(await leadRotationTick(d, procs)).toMatchObject([{ action: "lead-rotated" }]);
    expect(lead.ran[1]).toContain(`인수인계 문서(${file})와 상시 운영 문서(${ops})`);
    expect(lead.ran[1]).not.toContain("$(");
  });

  test("a bad leadModel fails the rotation before the old lead is stopped", async () => {
    const { d, lead, killed, procs } = rig({ leadModel: 5 });
    lead.screen = footer("350K");
    await leadRotationTick(d, procs);
    writeFileSync(handoffFile(lead.received.at(-1)!), "# handoff\n");
    expect(await leadRotationTick(d, procs)).toMatchObject([{ action: "lead-rotate-failed" }]);
    expect(killed).toEqual([]);
    expect(lead.ran).toEqual([]);
  });

  test("a new lead that never shows up fails the rotation with a notice instead of a silent empty pane", async () => {
    const { d, lead, killed, notified, procs: base } = rig();
    const procs = {
      ...base,
      kill: (pid: number) => {
        killed.push(pid);
        lead.status = "shell"; // the old agent exits; the shell then refuses the typed command
      },
    };
    lead.screen = footer("350K");
    await leadRotationTick(d, procs);
    writeFileSync(handoffFile(lead.received.at(-1)!), "# handoff\n");
    const [failed] = await leadRotationTick(d, procs);
    expect(failed).toMatchObject({ pane: "w1:p1", action: "lead-rotate-failed" });
    expect(failed?.detail).toContain("no omo in front of the lead pane w1:p1");
    expect(killed).toEqual([101]);
    expect(readFileSync(rotationLog(d.store.root), "utf8")).not.toContain("[LEAD ROTATED]");
    await hooksSettled();
    expect(notified).toEqual([expect.stringContaining("[LEAD ROTATE FAILED] w1:p1")]);
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
