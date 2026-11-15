import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import { main } from "../src/cli.ts";
import { extendStanding, startStanding, stopStanding } from "../src/cli-lead.ts";
import { dutyTick } from "../src/duty.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { dashboardState } from "../src/serve-state.ts";
import { DAY, leadState, routeStanding, tellOwner } from "../src/standing.ts";
import type { LoopRun } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

const LEADS = [{ domain: "vibeguard", keyPrefixes: ["vg-"], repos: ["vibeguard-run/web"], bots: ["endo"] }];

function world(opts: { leads?: unknown } = {}) {
  const s = setup();
  writeFileSync(join(s.d.store.root, "leads.json"), JSON.stringify(opts.leads ?? LEADS));
  const on = async () => {
    const state = await startStanding(s.d, "vibeguard", { group: "w1" });
    const pane = s.w.panes.get(state.sessionRef.id)!;
    pane.status = "idle";
    return { state, pane };
  };
  return { ...s, on };
}

const emptyRun = (at: number): LoopRun => ({ at, synced: [], findings: [], started: [], held: [], asked: [] });

describe("standing lead routing", () => {
  test("on: an owned lane's START and REPORT go only to the standing lead; READY goes to both; other lanes to the lead", async () => {
    const { d, lead, brief, on } = world();
    const { pane } = await on();
    const lane = await startLane(d, "vg-issue-1", brief, { group: "w1" });
    await report(d, "vg-issue-1", "tests green");
    expect(pane.received).toEqual([
      `[START vg-issue-1] lane opened in ${lane.paneId}`,
      "[REPORT vg-issue-1] tests green",
    ]);
    expect(lead.received).toEqual([]);
    await ready(d, "vg-issue-1", "done", ["https://github.com/vibeguard-run/web/pull/9"]);
    const readyLine = "[READY vg-issue-1] done\nevidence: https://github.com/vibeguard-run/web/pull/9";
    expect(lead.received).toEqual([readyLine]);
    expect(pane.received.at(-1)).toBe(readyLine);
    await startLane(d, "fix-login", brief, { group: "w1" });
    expect(lead.received.at(-1)).toStartWith("[START fix-login]");
    expect(pane.received).toHaveLength(3);
  });

  test("on: ESCALATE gives the lead a one-line summary and the standing lead the full text; LOST goes to the standing lead", async () => {
    const { w, d, lead, brief, on } = world();
    const { pane } = await on();
    const lane = await startLane(d, "vg-issue-2", brief, { group: "w1" });
    await tellOwner(d, "vg-issue-2", "[ESCALATE vg-issue-2] idle 80 min\nsecond line", "duty", "summary");
    expect(lead.received).toEqual(["[ESCALATE vg-issue-2] idle 80 min (sent to standing lead vibeguard)"]);
    expect(pane.received.at(-1)).toBe("[ESCALATE vg-issue-2] idle 80 min\nsecond line");
    w.panes.delete(lane.paneId);
    await dutyTick(d);
    expect(pane.received.at(-1)).toStartWith("[LOST vg-issue-2]");
    expect(lead.received).toHaveLength(1);
  });

  test("an item imported from an owned repo is owned by its source even without the key prefix", async () => {
    const { d, lead, brief, on } = world();
    const { pane } = await on();
    backlogAdd(d, "web-12", brief, { cwd: d.store.root, source: "vibeguard-run/web#12" });
    await startLane(d, "web-12", brief, { group: "w1" });
    expect(pane.received.at(-1)).toStartWith("[START web-12]");
    expect(lead.received).toEqual([]);
  });

  test("off: never started, or stopped, routes everything to the lead as before", async () => {
    const { d, lead, brief, on } = world();
    await startLane(d, "vg-issue-3", brief, { group: "w1" });
    expect(lead.received.at(-1)).toStartWith("[START vg-issue-3]");
    const { pane } = await on();
    await stopStanding(d, "vibeguard", "trial over");
    await report(d, "vg-issue-3", "still going");
    expect(lead.received.at(-1)).toBe("[REPORT vg-issue-3] still going");
    expect(pane.received).toEqual([]);
  });

  test("a standing lead whose pane is gone is marked stopped once and its lanes report to the lead", async () => {
    const { w, d, lead, brief, on } = world();
    const { state } = await on();
    await startLane(d, "vg-issue-4", brief, { group: "w1" });
    w.panes.delete(state.sessionRef.id);
    await report(d, "vg-issue-4", "halfway");
    expect(lead.received).toEqual([
      expect.stringContaining("[STANDING vibeguard] pane herdr:"),
      "[REPORT vg-issue-4] halfway",
    ]);
    expect(leadState(d.store.root, "vibeguard")?.stopReason).toBe("pane gone");
    await report(d, "vg-issue-4", "done soon");
    expect(lead.received).toHaveLength(3);
  });
});

describe("standing lead start and stop", () => {
  test("start opens a tab with the rendered prompt, refuses a second start and an unknown domain", async () => {
    const { w, d, on } = world();
    const { state } = await on();
    const ran = w.panes.get(state.sessionRef.id)!.ran[0]!;
    expect(ran).toStartWith("omo --append-system-prompt ");
    const rendered = readFileSync(join(d.store.root, "prompts", "standing-lead-vibeguard.md"), "utf8");
    expect(rendered).toContain("standing lead for the **vibeguard** domain");
    expect(rendered).toContain("lane keys starting with vg-");
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    expect(state.trialEndsAt - state.startedAt).toBe(7 * DAY);
    await expect(startStanding(d, "vibeguard", { group: "w1" })).rejects.toThrow("already running");
    await expect(startStanding(d, "coupas", { group: "w1" })).rejects.toThrow("no standing lead coupas");
  });

  test("stop closes the pane and hands its unread messages to the lead; stop again is refused", async () => {
    const { w, d, lead, brief, on } = world();
    const { state, pane } = await on();
    await startLane(d, "vg-issue-5", brief, { group: "w1" });
    pane.status = "working";
    await report(d, "vg-issue-5", "queued for the busy standing lead");
    await stopStanding(d, "vibeguard", "by hand");
    expect(w.panes.has(state.sessionRef.id)).toBe(false);
    expect(lead.received.at(-1)).toContain("[STANDING vibeguard] stopped with 1 unread message(s)");
    expect(lead.received.at(-1)).toContain("[REPORT vg-issue-5] queued for the busy standing lead");
    expect(d.store.queued(state.sessionRef)).toEqual([]);
    await expect(stopStanding(d, "vibeguard", "again")).rejects.toThrow("is not running");
  });

  test("dori lead start | status | stop on the command line", async () => {
    const { w, d } = world();
    const out: string[] = [];
    const log = console.log;
    console.log = (line: string) => out.push(line);
    try {
      expect(await main(["lead", "start", "vibeguard"], d)).toBe(0);
      expect(await main(["lead", "status"], d)).toBe(0);
      expect(await main(["lead", "stop", "vibeguard"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(out[0]).toMatch(/^LEAD_STARTED vibeguard pane=w1:p\d+ trial-ends=\d{4}-\d{2}-\d{2}$/);
    expect(out[1]).toMatch(/^vibeguard on pane=w1:p\d+ trial 7d left/);
    expect(out[2]).toBe("LEAD_STOPPED vibeguard");
    const started = /pane=(\S+)/.exec(out[0]!)![1]!;
    expect(w.panes.has(started)).toBe(false);
  });
});

describe("standing lead in the hourly loop and on the board", () => {
  test("an owned item's DECIDE goes to the standing lead, not the lead's summary", async () => {
    const { d, lead, brief, on } = world();
    const { pane } = await on();
    backlogAdd(d, "vg-issue-6", brief, { cwd: d.store.root, decision: "which plan?" });
    backlogAdd(d, "other-1", brief, { cwd: d.store.root, decision: "which color?" });
    await loopTick(d, { force: true });
    expect(pane.received.at(-1)).toStartWith("[DECIDE vg-issue-6] which plan?");
    const summary = lead.received.at(-1)!;
    expect(summary).toContain("[DECIDE other-1] which color?");
    expect(summary).not.toContain("[DECIDE vg-issue-6]");
    expect(summary).toContain("1 decision(s) sent to standing lead vibeguard");
  });

  test("a trial past its end asks the lead once; extend starts a new trial", async () => {
    const { w, d, on } = world();
    await on();
    w.clock += 7 * DAY - 1;
    const early = emptyRun(w.clock);
    await routeStanding(d, early);
    expect(early.asked).toEqual([]);
    w.clock += 1;
    const due = emptyRun(w.clock);
    await routeStanding(d, due);
    expect(due.asked).toEqual([
      "[DECIDE lead-vibeguard] standing lead vibeguard trial ended after 7 day(s): keep or stop? -> dori lead extend vibeguard --days 7 | dori lead stop vibeguard",
    ]);
    const again = emptyRun(w.clock);
    await routeStanding(d, again);
    expect(again.asked).toEqual([]);
    expect(extendStanding(d, "vibeguard", 3).trialEndsAt).toBe(w.clock + 3 * DAY);
    expect(leadState(d.store.root, "vibeguard")?.trialAskedAt).toBeUndefined();
  });

  test("the board shows each standing lead: on or off, trial days left, lanes it owns", async () => {
    const { w, d, brief, on } = world();
    expect(dashboardState(d.store, w.clock).leads).toEqual([
      { domain: "vibeguard", on: false, pane: null, trialDaysLeft: null, lanes: 0 },
    ]);
    const { state } = await on();
    await startLane(d, "vg-issue-7", brief, { group: "w1" });
    await startLane(d, "fix-login", brief, { group: "w1" });
    expect(dashboardState(d.store, w.clock + 2 * DAY).leads).toEqual([
      { domain: "vibeguard", on: true, pane: state.sessionRef.id, trialDaysLeft: 5, lanes: 1 },
    ]);
  });

  test("a malformed leads.json is refused with what is wrong", async () => {
    const { d } = world({ leads: [{ domain: "Bad Domain" }] });
    await expect(startStanding(d, "vibeguard")).rejects.toThrow("domain must match");
  });
});
