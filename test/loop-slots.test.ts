import { describe, expect, test } from "bun:test";
import { ready, startLane } from "../src/lanes.ts";
import { setup } from "./loop-setup.ts";

describe("which lanes hold the loop's slots", () => {
  test("a READY backlog lane frees its slot; the item stays running until its lane is done", async () => {
    const { d, add, tick } = setup();
    add("first");
    add("second");
    expect((await tick({ maxLanes: 1 })).started).toEqual(["first (p5)"]);
    expect((await tick({ maxLanes: 1 })).held).toEqual(["1 item(s) waiting: 0 free of 1 lanes, max 2/run"]);
    await ready(d, "first", "done", ["https://example.com/receipt"]);
    const run = await tick({ maxLanes: 1 });
    expect(run.started).toEqual(["second (p5)"]);
    expect(run.status!.lanes).toBe(1);
    expect(d.store.item("first")!.status).toBe("running");
  });

  test("ad-hoc lanes the lead opened never fill the backlog's slots", async () => {
    const { d, brief, add, tick } = setup();
    add("next");
    await startLane(d, "chat-a", brief, { group: "w1" });
    await startLane(d, "chat-b", brief, { group: "w1" });
    const run = await tick({ maxLanes: 1 });
    expect(run.started).toEqual(["next (p5)"]);
    expect(run.status!.adhoc).toEqual(["chat-a", "chat-b"]);
  });
});
