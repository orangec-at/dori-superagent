import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptLane } from "../src/adopt.ts";
import { dutyTick, NUDGE_MINUTES } from "../src/duty.ts";
import { flushInbox } from "../src/inbox.ts";
import { done, ready } from "../src/lanes.ts";
import { main } from "../src/cli.ts";
import { setup } from "./harness-setup.ts";

const saved = process.env["DORI_SSH_HOST"];
beforeEach(() => {
  process.env["DORI_SSH_HOST"] = "fedora";
});
afterEach(() => {
  if (saved === undefined) delete process.env["DORI_SSH_HOST"];
  else process.env["DORI_SSH_HOST"] = saved;
});

function claudePane(w: ReturnType<typeof setup>["w"], id: string, status: "idle" | "working" = "idle") {
  const p = w.addPane(id, status);
  p.agent = "claude";
  p.foreground = "claude";
  return p;
}

describe("dori adopt", () => {
  test("registers an idle Claude Code pane as a lane, delivers brief, note and rules once, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const pane = claudePane(w, "w4:p1");
    const { lane, sent } = await adoptLane(d, "tossinapp", "w4:p1", {
      brief,
      note: "Move it to fedora.",
      cwd: "/repo",
    });
    expect(sent).toBe("DELIVERED");
    expect(lane).toMatchObject({ status: "working", adopted: true, cwd: "/repo", sessionRef: { id: "w4:p1" } });
    expect(pane.received).toHaveLength(1);
    const text = pane.received[0]!;
    for (const part of ["This session is now lane tossinapp", "Fix the flaky login test.", "Move it to fedora."])
      expect(text).toContain(part);
    expect(text).toContain("dori ready tossinapp --text");
    expect(await Bun.file(lane.brief).text()).toContain("Move it to fedora.");
    expect(lead.received).toEqual(["[ADOPT tossinapp] lane adopted in w4:p1"]);
    expect(w.calls.some((c) => c.argv.includes("run") || c.argv.includes("create"))).toBe(false);
  });

  test("a working pane is not interrupted: the rules wait in its inbox until it is idle", async () => {
    const { w, d } = setup();
    const pane = claudePane(w, "w5:p1", "working");
    const { sent } = await adoptLane(d, "yogaday", "w5:p1", { note: "Wait for the address file." });
    expect(sent).toBe("QUEUED");
    expect(pane.received).toEqual([]);
    pane.status = "idle";
    expect(await flushInbox(d, { runtime: "herdr", id: "w5:p1" })).toBe("delivered");
    expect(pane.received[0]).toContain("Wait for the address file.");
  });

  test("a pane on another machine gets the ssh rules and is reached through herdr --machine", async () => {
    const { w, d } = setup();
    const pane = claudePane(w, "w4:p3");
    const { lane } = await adoptLane(d, "yogaday-pr", "w4:p3", { machine: "ubuntu" });
    expect(lane.sessionRef).toMatchObject({ id: "w4:p3", machine: "ubuntu" });
    expect(pane.received[0]).toContain("| ssh fedora 'dori' report yogaday-pr");
    expect(pane.received[0]).toContain("Continue the task already in progress");
    expect(w.calls.filter((c) => c.argv.includes("w4:p3")).every((c) => c.argv[1] === "ubuntu")).toBe(true);
  });

  test("refuses a pane with no agent, a gone pane, a pane another lane runs in, and a machine mismatch", async () => {
    const { w, d } = setup();
    w.addPane("w2:p1", "shell");
    await expect(adoptLane(d, "a-shell", "w2:p1")).rejects.toThrow("no agent running");
    await expect(adoptLane(d, "a-gone", "w9:p9")).rejects.toThrow("is gone");
    await expect(adoptLane(d, "a-bad", "nope")).rejects.toThrow("not a session ref");
    await expect(adoptLane(d, "a-mix", "w4:p3@ubuntu", { machine: "mini" })).rejects.toThrow("names machine ubuntu");
    claudePane(w, "w6:p1");
    await adoptLane(d, "vibeguard", "w6:p1");
    await expect(adoptLane(d, "vibeguard-2", "w6:p1")).rejects.toThrow("already lane vibeguard");
    await expect(adoptLane(d, "vibeguard", "w6:p1")).rejects.toThrow("already open");
    expect(d.store.lane("a-shell")).toBeUndefined();
  });

  test("duty nudges a silent adopted lane; done ends the lane and leaves the operator's pane open", async () => {
    const { w, d } = setup();
    const pane = claudePane(w, "w6:p1");
    await adoptLane(d, "vibeguard", "w6:p1");
    w.clock += (NUDGE_MINUTES[0] + 1) * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "vibeguard", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("dori ready vibeguard --text");
    await ready(d, "vibeguard", "renamed", ["https://github.com/o/r/pull/3"]);
    await done(d, "vibeguard");
    expect(w.panes.has("w6:p1")).toBe(true);
    expect(w.calls.some((c) => c.argv.includes("close"))).toBe(false);
    expect(d.store.lane("vibeguard")!.status).toBe("done");
  });

  test("the CLI prints ADOPTED and passes --machine, --brief and --note through", async () => {
    const { w, d } = setup();
    claudePane(w, "w5:p1");
    const brief = join(d.store.root, "b.md");
    writeFileSync(brief, "Compare the admin docs.");
    const logs: string[] = [];
    const log = console.log;
    console.log = (s: string) => void logs.push(s);
    try {
      const args = ["adopt", "supabase", "--pane", "w5:p1", "--machine", "ubuntu", "--brief", brief, "--note", "Go."];
      expect(await main(args, d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(logs[0]).toMatch(/^ADOPTED supabase pane=w5:p1@ubuntu brief=/);
    expect(d.store.lane("supabase")!.sessionRef.machine).toBe("ubuntu");
  });
});
