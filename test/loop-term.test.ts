import { describe, expect, spyOn, test } from "bun:test";
import { main } from "../src/cli.ts";
import { onTerm } from "../src/loop-term.ts";
import { World } from "./fake.ts";

const term = () => (process.emit as (e: string) => boolean)("SIGTERM");

describe("onTerm", () => {
  test("SIGTERM during a pass only raises the flag: the pass runs to its end", async () => {
    const t = onTerm();
    const steps: string[] = [];
    const pass = async (): Promise<void> => {
      steps.push("deliver");
      term();
      await Promise.resolve();
      steps.push("record");
    };
    await pass();
    expect(steps).toEqual(["deliver", "record"]);
    expect(t.stopped()).toBe(true);
    // The wait between passes is then skipped: the loop leaves at once instead of sleeping out its interval.
    await t.wait(1_000_000);
    t.off();
  });

  test("a wait already under way is woken by SIGTERM", async () => {
    const t = onTerm();
    const waiting = t.wait(1_000_000);
    expect(t.stopped()).toBe(false);
    term();
    await waiting;
    expect(t.stopped()).toBe(true);
    t.off();
  });

  test("off leaves no handler behind", () => {
    const before = process.listenerCount("SIGTERM");
    const t = onTerm();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    t.off();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("dori duty", () => {
  test("SIGTERM ends the loop after the pass, without waiting out the interval", async () => {
    const d = new World().deps();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      // runDuty registers its handler before its first await, so the signal lands on the running loop.
      const running = main(["duty", "--interval", "1000000"], d);
      term();
      expect(await running).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(lines.join("\n")).toContain("DUTY STOPPED by SIGTERM after this pass");
  });
});
