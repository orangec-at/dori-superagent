import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { startStanding, stopStanding } from "../src/cli-lead.ts";
import { report, startLane } from "../src/lanes.ts";
import { DAY, leadState, loadLeads, routingLeads } from "../src/standing.ts";
import { routeStanding } from "../src/standing-loop.ts";
import { retire, STUCK_MS } from "../src/standing-route.ts";
import { emptyRun, world } from "./standing-setup.ts";

describe("a standing lead that cannot read is retired", () => {
  test("its agent exited (a bare shell): the next message retires it and goes to the lead", async () => {
    const { w, d, lead, brief, on } = world();
    const { state, pane } = await on();
    await startLane(d, "vg-issue-20", brief, { group: "w1" });
    pane.status = "shell";
    await report(d, "vg-issue-20", "after the crash");
    expect(lead.received).toEqual([
      "[STANDING vibeguard] agent exited; its lanes report to the lead again (dori lead start vibeguard to reopen)",
      "[REPORT vg-issue-20] after the crash",
    ]);
    expect(leadState(d.store.root, "vibeguard")?.stopReason).toBe("agent exited");
    expect(w.panes.has(state.sessionRef.id)).toBe(false);
  });

  test("blocked with a message unread for STUCK_MS: the hourly pass retires it and hands the message over", async () => {
    const { w, d, lead, brief, on } = world();
    const { state, pane } = await on();
    await startLane(d, "vg-issue-21", brief, { group: "w1" });
    pane.status = "blocked";
    await report(d, "vg-issue-21", "waiting for you");
    const early = emptyRun(w.clock + STUCK_MS - 1);
    w.clock += STUCK_MS - 1;
    await routeStanding(d, early);
    expect(early.findings).toEqual([]);
    expect(lead.received).toEqual([]);
    w.clock += 1;
    const due = emptyRun(w.clock);
    await routeStanding(d, due);
    expect(due.findings).toEqual(["standing lead vibeguard retired: agent blocked with a message unread for 30 min"]);
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain(
      "1 unread message(s):\n\nfrom vg-issue-21: [REPORT vg-issue-21] waiting for you",
    );
    expect(w.panes.has(state.sessionRef.id)).toBe(false);
  });

  test("a probe that throws falls back to the lead instead of failing the lane", async () => {
    const { w, d, lead, brief, on } = world();
    const { state } = await on();
    await startLane(d, "vg-issue-22", brief, { group: "w1" });
    w.getHook.set(state.sessionRef.id, () => {
      throw new Error("herdr socket closed");
    });
    await report(d, "vg-issue-22", "still arrives");
    expect(lead.received.at(-1)).toBe("[REPORT vg-issue-22] still arrives");
  });

  test("concurrent retires of one session hand its unread messages to the lead once", async () => {
    const { d, lead, brief, on } = world();
    const { state, pane } = await on();
    await startLane(d, "vg-issue-23", brief, { group: "w1" });
    pane.status = "working";
    await report(d, "vg-issue-23", "once");
    await Promise.all([retire(d, state, "pane gone"), retire(d, state, "pane gone")]);
    expect(lead.received.filter((t) => t.includes("[REPORT vg-issue-23] once"))).toHaveLength(1);
  });

  test("a restart before the trial's end keeps its start, so the trial question counts the whole trial", async () => {
    const { w, d, on } = world();
    await on();
    w.clock += 3 * DAY;
    await stopStanding(d, "vibeguard", "restart");
    w.clock += 1;
    const again = await startStanding(d, "vibeguard", { group: "w1" });
    w.panes.get(again.sessionRef.id)!.status = "idle";
    w.clock = again.trialEndsAt;
    const run = emptyRun(w.clock);
    await routeStanding(d, run);
    expect(run.asked[0]).toContain("trial ended after 7 day(s)");
  });
});

describe("leads.json details", () => {
  test("~/ in cwds and cwd is the home directory", () => {
    const { d } = world({ leads: [{ domain: "vibeguard", cwds: ["~/vg"], cwd: "~/vg/web" }] });
    const [def] = loadLeads(d.store.root);
    expect(def?.cwds).toEqual([join(homedir(), "vg")]);
    expect(def?.cwd).toBe(join(homedir(), "vg/web"));
  });

  test("concurrent readers of a malformed leads.json warn the lead once between them", async () => {
    const { d, lead } = world({ leads: "[1," });
    const all = await Promise.all([routingLeads(d), routingLeads(d), routingLeads(d)]);
    expect(all).toEqual([[], [], []]);
    expect(lead.received.filter((t) => t.startsWith("[STANDING]"))).toHaveLength(1);
  });
});
