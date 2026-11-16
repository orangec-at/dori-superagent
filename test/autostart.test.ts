import { describe, expect, test } from "bun:test";
import { doneThenStart, startNow } from "../src/autostart.ts";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { ready } from "../src/lanes.ts";
import { setup } from "./loop-setup.ts";

describe("autostart: a free slot goes to the next item without waiting for the hourly loop", () => {
  test("dori backlog add starts the item at once", async () => {
    const { d, brief } = setup();
    expect(await main(["backlog", "add", "fresh", "--brief", brief, "--cwd", d.store.root], d)).toBe(0);
    expect(d.store.item("fresh")!.status).toBe("running");
    expect(d.store.lane("fresh")!.status).toBe("working");
    expect(d.store.item("fresh")!.log.at(-1)!.text).toBe("lane opened by autostart after backlog add");
  });

  test("keeps the 3-lane limit, and dori done hands the freed slot to the next item", async () => {
    const { w, d, add } = setup();
    for (const id of ["a1", "a2", "a3", "a4"]) add(id);
    const limits = { maxLanes: 3, maxStarts: 2, maxLoad: undefined };
    expect(await startNow(d, "test", limits)).toEqual(["started a1 (p5)", "started a2 (p5)"]);
    expect(await startNow(d, "test", limits)).toEqual(["started a3 (p5)"]);
    expect(await startNow(d, "test", limits)).toEqual([]);
    expect(d.store.item("a4")!.status).toBe("open");
    await ready(d, "a1", "done", ["https://example.com/pr/1"]);
    w.panes.get(d.store.lane("a1")!.paneId)!.status = "idle";
    expect(await doneThenStart(d, "a1", limits)).toEqual(["started a4 (p5)"]);
    expect(d.store.lane("a1")!.status).toBe("done");
  });

  test("a duty pass starts waiting work; a busy host or a stopped loop starts nothing", async () => {
    const { w, d, add } = setup();
    add("later");
    w.host = { load1: 20, cores: 8, memFreePct: 50 };
    expect(await startNow(d, "test")).toEqual([]);
    d.store.setStop(w.clock, "paused");
    w.host = { load1: 1, cores: 8, memFreePct: 50 };
    expect(await startNow(d, "test")).toEqual([]);
    d.store.clearStop();
    expect(await dutyTick(d)).toContainEqual({ action: "autostart", detail: "started later (p5)" });
    expect(d.store.item("later")!.status).toBe("running");
  });
});
