import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import { main } from "../src/cli.ts";
import { startStanding, stopStanding } from "../src/cli-lead.ts";
import { dutyTick } from "../src/duty.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { DAY, leadState } from "../src/standing.ts";
import { tellOwner } from "../src/standing-route.ts";
import { cli, world } from "./standing-setup.ts";

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

  test("a standing lead whose pane is gone is retired once and its lanes report to the lead", async () => {
    const { w, d, lead, brief, on } = world();
    const { state } = await on();
    await startLane(d, "vg-issue-4", brief, { group: "w1" });
    w.panes.delete(state.sessionRef.id);
    await report(d, "vg-issue-4", "halfway");
    expect(lead.received).toEqual([
      "[STANDING vibeguard] pane gone; its lanes report to the lead again (dori lead start vibeguard to reopen)",
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
    expect(rendered).toContain("- Never merge a site PR before makun approves it.");
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
    expect(lead.received.at(-1)).toStartWith("[STANDING vibeguard] by hand;");
    expect(lead.received.at(-1)).toContain("1 unread message(s):\n\nfrom vg-issue-5: [REPORT vg-issue-5] queued");
    expect(d.store.queued(state.sessionRef)).toEqual([]);
    await expect(stopStanding(d, "vibeguard", "again")).rejects.toThrow("is not running");
  });

  test("stop with no lead registered keeps the unread messages in the standing lead's inbox", async () => {
    const { d, brief, on } = world();
    const { state, pane } = await on();
    await startLane(d, "vg-issue-8", brief, { group: "w1" });
    pane.status = "working";
    await report(d, "vg-issue-8", "kept");
    writeFileSync(join(d.store.root, "roles.json"), "{}\n");
    await stopStanding(d, "vibeguard", "by hand");
    expect(d.store.queued(state.sessionRef).map((m) => m.text)).toEqual(["[REPORT vg-issue-8] kept"]);
  });

  test("dori lead start | status | extend | stop on the command line", async () => {
    const { w, d } = world();
    const run = (argv: string[]) => main(argv, d);
    const started = await cli(run, ["lead", "start", "vibeguard"]);
    expect(started.out[0]).toMatch(/^LEAD_STARTED vibeguard pane=w1:p\d+ trial-ends=\d{4}-\d{2}-\d{2}$/);
    expect((await cli(run, ["lead", "status"])).out[0]).toMatch(/^vibeguard on pane=w1:p\d+ trial 7d left/);
    await expect(run(["lead", "extend", "vibeguard", "--days", "abc"])).rejects.toThrow("--days must be a positive");
    const extended = await cli(run, ["lead", "extend", "vibeguard", "--days", "3"]);
    expect(extended.out).toEqual([
      `LEAD_EXTENDED vibeguard trial-ends=${new Date(w.clock + 3 * DAY).toISOString().slice(0, 10)}`,
    ]);
    expect((await cli(run, ["lead", "stop", "vibeguard"])).out).toEqual(["LEAD_STOPPED vibeguard"]);
    expect(w.panes.has(/pane=(\S+)/.exec(started.out[0]!)![1]!)).toBe(false);
  });
});
