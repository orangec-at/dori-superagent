import { describe, expect, test } from "bun:test";
import { backlogAdd } from "../src/backlog.ts";
import { extendStanding, refuseForStanding } from "../src/cli-lead.ts";
import { dutyTick } from "../src/duty.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { dashboardState } from "../src/serve-state.ts";
import { DAY, leadState } from "../src/standing.ts";
import { markTrialsAsked, routeStanding } from "../src/standing-loop.ts";
import { tellOwner } from "../src/standing-route.ts";
import { href } from "./fake.ts";
import { emptyRun, world } from "./standing-setup.ts";

const TRIAL_LINE =
  "[DECIDE lead-vibeguard] standing lead vibeguard trial ended after 7 day(s): keep or stop? -> dori lead extend vibeguard --days 7 | dori lead stop vibeguard";

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

  test("a trial past its end is asked until the lead's summary carried it, then never again", async () => {
    const { w, d, on } = world();
    await on();
    w.clock += 7 * DAY - 1;
    const early = emptyRun(w.clock);
    await routeStanding(d, early);
    expect(early.asked).toEqual([]);
    w.clock += 1;
    for (const _ of [1, 2]) {
      const unsent = emptyRun(w.clock);
      await routeStanding(d, unsent);
      expect(unsent.asked).toEqual([TRIAL_LINE]);
    }
    const sent = emptyRun(w.clock);
    await routeStanding(d, sent);
    markTrialsAsked(d, sent);
    const again = emptyRun(w.clock);
    await routeStanding(d, again);
    expect(again.asked).toEqual([]);
    expect(extendStanding(d, "vibeguard", 3).trialEndsAt).toBe(w.clock + 3 * DAY);
    expect(leadState(d.store.root, "vibeguard")?.trialAskedAt).toBeUndefined();
  });

  test("the hourly pass puts the trial question in the lead's summary and records it", async () => {
    const { w, d, lead, on } = world();
    await on();
    w.clock += 7 * DAY;
    await loopTick(d, { force: true });
    expect(lead.received.at(-1)).toContain(TRIAL_LINE);
    expect(leadState(d.store.root, "vibeguard")?.trialAskedAt).toBe(w.clock);
  });

  test("the board shows each standing lead: on or off, trial days left, lanes it owns", async () => {
    const { w, d, brief, on } = world();
    expect(dashboardState(d.store, w.clock).leads).toEqual([
      { domain: "vibeguard", on: false, pane: null, trialDaysLeft: null, lanes: 0 },
    ]);
    const { state } = await on();
    await startLane(d, "vg-issue-7", brief, { group: "w1" });
    await startLane(d, "fix-login", brief, { group: "w1" });
    const later = dashboardState(d.store, w.clock + 2 * DAY);
    expect(later.leads).toEqual([
      { domain: "vibeguard", on: true, pane: state.sessionRef.id, trialDaysLeft: 5, lanes: 1 },
    ]);
    expect(later.leadsError).toBeNull();
  });
});

describe("standing lead failures fall back to the lead", () => {
  test("a malformed leads.json: lanes, duty, the hourly loop and the board keep working; the lead is warned once", async () => {
    const { w, d, lead, brief } = world({ leads: "{not json" });
    const lane = await startLane(d, "vg-issue-9", brief, { group: "w1" });
    await report(d, "vg-issue-9", "fine");
    expect(lead.received[0]).toStartWith("[STANDING] ");
    expect(lead.received[0]).toContain("leads.json is not JSON");
    expect(lead.received.slice(1)).toEqual([
      `[START vg-issue-9] lane opened in ${lane.paneId}`,
      "[REPORT vg-issue-9] fine",
    ]);
    w.panes.delete(lane.paneId);
    expect((await dutyTick(d)).filter((e) => e.action === "lost")).toEqual([{ lane: "vg-issue-9", action: "lost" }]);
    expect(lead.received.at(-1)).toStartWith("[LOST vg-issue-9]");
    expect((await loopTick(d, { force: true })).skipped).toBeUndefined();
    expect(lead.received.filter((t) => t.startsWith("[STANDING]"))).toHaveLength(1);
    const board = dashboardState(d.store, w.clock);
    expect(board.leads).toEqual([]);
    expect(board.leadsError).toContain("is not JSON");
  });

  test("a pane gone with messages queued in its inbox: the lead gets them when the pane is found gone", async () => {
    const { w, d, lead, brief, on } = world();
    const { state, pane } = await on();
    await startLane(d, "vg-issue-10", brief, { group: "w1" });
    pane.status = "working";
    await report(d, "vg-issue-10", "first, queued");
    w.panes.delete(state.sessionRef.id);
    await report(d, "vg-issue-10", "second");
    expect(lead.received[0]).toContain("pane gone;");
    expect(lead.received[0]).toContain("1 unread message(s):\n\nfrom vg-issue-10: [REPORT vg-issue-10] first, queued");
    expect(lead.received[1]).toBe("[REPORT vg-issue-10] second");
    expect(d.store.queued(state.sessionRef)).toEqual([]);
  });

  test("a pane that closes between the probe and the delivery: the message reaches the lead, READY only once", async () => {
    const { w, d, lead, brief, on } = world();
    const { state } = await on();
    await startLane(d, "vg-issue-11", brief, { group: "w1" });
    w.getHook.set(state.sessionRef.id, () => w.panes.delete(state.sessionRef.id));
    await ready(d, "vg-issue-11", "shipped", ["https://github.com/vibeguard-run/web/pull/11"]);
    const readyLine = "[READY vg-issue-11] shipped\nevidence: https://github.com/vibeguard-run/web/pull/11";
    expect(lead.received).toEqual([
      readyLine,
      "[STANDING vibeguard] pane gone; its lanes report to the lead again (dori lead start vibeguard to reopen)",
    ]);
    expect(leadState(d.store.root, "vibeguard")?.stopReason).toBe("pane gone");
    expect(d.store.queued(state.sessionRef)).toEqual([]);
  });

  test("an ESCALATE whose standing lead closes before delivery: the lead gets the summary, then the full text", async () => {
    const { w, d, lead, brief, on } = world();
    const { state } = await on();
    await startLane(d, "vg-issue-13", brief, { group: "w1" });
    w.getHook.set(state.sessionRef.id, () => w.panes.delete(state.sessionRef.id));
    await tellOwner(d, "vg-issue-13", "[ESCALATE vg-issue-13] idle 80 min\ndetails", "duty", "summary");
    expect(lead.received[0]).toBe("[ESCALATE vg-issue-13] idle 80 min (sent to standing lead vibeguard)");
    expect(lead.received[1]).toContain(
      "1 unread message(s):\n\nfrom duty: [ESCALATE vg-issue-13] idle 80 min\ndetails",
    );
  });

  test("an uncertain lead delivery while retiring a gone pane never loses the lane's message", async () => {
    const { w, d, brief, on } = world();
    const { state } = await on();
    await startLane(d, "vg-issue-12", brief, { group: "w1" });
    w.panes.delete(state.sessionRef.id);
    w.promptFails.set("w1:p1", "connection reset by peer");
    expect(await report(d, "vg-issue-12", "must arrive")).toBe("HELD");
    expect(leadState(d.store.root, "vibeguard")?.stopReason).toBe("pane gone");
    expect(d.store.queued(href("w1:p1")).map((m) => m.text)).toContain("[REPORT vg-issue-12] must arrive");
  });

  test("a standing lead's session is refused the lead's commands", () => {
    const env = { DORI_STANDING_LEAD: "vibeguard" };
    for (const cmd of ["merge", "done", "reply", "ask", "self-update"])
      expect(() => refuseForStanding([cmd], env)).toThrow(`dori ${cmd} is the lead's`);
    for (const sub of ["extend", "stop", "start", "rotate"])
      expect(() => refuseForStanding(["lead", sub, "vibeguard"], env)).toThrow(`dori lead ${sub} is the lead's`);
    expect(() => refuseForStanding(["lead", "status"], env)).not.toThrow();
    expect(() => refuseForStanding(["report", "vg-1"], env)).not.toThrow();
    expect(() => refuseForStanding(["merge"], {})).not.toThrow();
  });
});
