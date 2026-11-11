import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCost } from "../src/budget.ts";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { dashboardState } from "../src/serve-state.ts";
import { setup } from "./harness-setup.ts";

const screen = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "screens", `${name}.txt`), "utf8");
const costing = (usd: string) => screen("omo-cost").replace("$0.743", `$${usd}`);

async function out(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines;
}

describe("lane budgets (#3)", () => {
  test("the cost is the last $ segment of omo's status line, never a $ amount in the conversation", () => {
    expect(parseCost(screen("omo-cost"))).toBe(0.743);
    expect(parseCost(screen("omo-turn"))).toBe(0);
    expect(parseCost(screen("omo-no-cost"))).toBeUndefined();
    expect(parseCost(screen("claude-idle"))).toBeUndefined();
  });

  test("80% and OVER each reach the lead once; an OVER lane is not nudged and keeps running", async () => {
    const { w, d, lead, brief } = setup();
    expect(await out(() => main(["budget", "set", "default", "--usd", "10"], d))).toEqual(["BUDGET default $10"]);
    const lane = await startLane(d, "spender", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    const budgetLines = () => lead.received.filter((m) => m.startsWith("[BUDGET"));
    const tick = async (usd: string) => {
      pane.screen = costing(usd);
      w.clock += 60_000;
      return dutyTick(d);
    };

    expect(await tick("7.5")).toEqual([]);
    expect(d.store.lane("spender")).toMatchObject({ costUsd: 7.5, costAt: w.clock });
    expect(await tick("8.2")).toEqual([{ lane: "spender", action: "budget-80" }]);
    expect(await tick("9.1")).toEqual([]);
    expect(await tick("10.4")).toEqual([{ lane: "spender", action: "budget-over" }]);
    expect(await tick("11")).toEqual([]);
    expect(budgetLines()).toEqual([
      "[BUDGET 80%] spender $8.2 / $10",
      "[BUDGET OVER] spender $10.4 / $10: nudges stopped; the lane keeps running",
    ]);

    pane.status = "idle";
    w.clock += 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(pane.received.filter((m) => m.includes("idle for"))).toEqual([]);
    expect(d.store.lane("spender")).toMatchObject({ status: "working", nudges: 0, costUsd: 11 });
    expect(w.panes.has(lane.paneId)).toBe(true);
  });

  test("an unreadable screen or one with no cost keeps the last reading", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "reader", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.screen = costing("2.5");
    await dutyTick(d);
    const first = w.clock;
    w.clock += 60_000;
    pane.screen = undefined;
    expect(await dutyTick(d)).toEqual([]);
    pane.screen = screen("omo-no-cost");
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("reader")).toMatchObject({ costUsd: 2.5, costAt: first });
  });

  test("budget set/show, dori status and the dashboard show each lane's cost against its limit", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "shown", brief, { group: "w1" });
    await startLane(d, "other", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "working";
    w.panes.get(lane.paneId)!.screen = costing("6.856");
    await dutyTick(d);

    expect(await out(() => main(["budget", "set", "shown", "--usd", "50"], d))).toEqual(["BUDGET shown $50"]);
    await expect(main(["budget", "set", "shown", "--usd", "-1"], d)).rejects.toThrow("--usd must be a positive");
    await expect(main(["budget", "set", "Bad Key", "--usd", "5"], d)).rejects.toThrow("a lane key or default");
    const show = await out(() => main(["budget", "show"], d));
    expect(show.slice(0, 2)).toEqual(["BUDGET default -", "BUDGET shown $50"]);
    expect(show.find((l) => l.startsWith("shown "))).toStartWith(`${"shown".padEnd(24)} $6.856 / $50 (14%)  read `);
    expect(show).toContain(`${"other".padEnd(24)} -`);

    const status = await out(() => main(["status"], d));
    expect(status.find((l) => l.startsWith("shown "))).toContain("cost $6.856 / $50 (14%)");
    const state = dashboardState(d.store, w.clock).lanes.find((l) => l.key === "shown");
    expect(state).toMatchObject({ costUsd: 6.856, costAt: w.clock, budgetUsd: 50 });
  });
});
