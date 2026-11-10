import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/cli-args.ts";
import { runDuty, runLoop } from "../src/cli-loops.ts";
import type { Deps } from "../src/harness.ts";
import { onTerm, type Term } from "../src/loop-term.ts";
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

/** A Term whose stop request is already in: the loop finishes the pass it is in and leaves, never waiting. */
const stopAfterPass = (): Term => ({ stopped: () => true, wait: async () => {}, off: () => {} });

async function captured<T>(body: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  try {
    return { value: await body(), lines };
  } finally {
    log.mockRestore();
  }
}

async function oneLoopPass(d: Deps, argv: string[]): Promise<{ code: number; started: number; lines: string[] }> {
  let started = 0;
  const start = () => void started++;
  const r = await captured(() => runLoop(d, parse(["loop", ...argv]), undefined, start, stopAfterPass));
  return { code: r.value, started, lines: r.lines };
}

describe("dori loop", () => {
  test("with auto off (the default) a pass that ran starts no self-update", async () => {
    const r = await oneLoopPass(new World().deps(), ["--interval", "1000000"]);
    expect(r.code).toBe(0);
    expect(r.started).toBe(0);
    expect(r.lines.join("\n")).toContain("SELF_UPDATE_OFF automatic runs are opt-in");
  });

  test("opted in, a pass that ran starts the self-update trigger, then a stop request ends the loop", async () => {
    const d = new World().deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate: { auto: true } }));
    const r = await oneLoopPass(d, ["--interval", "1000000"]);
    expect(r.code).toBe(0);
    expect(r.started).toBe(1);
    expect(r.lines.join("\n")).toContain("LOOP STOPPED by SIGTERM after this pass");
  });

  test("a stopped loop starts no self-update", async () => {
    const d = new World().deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate: { auto: true } }));
    d.store.setStop(d.now(), "maintenance");
    const r = await oneLoopPass(d, ["--interval", "1000000"]);
    expect(r.started).toBe(0);
    expect(r.lines.join("\n")).toContain("LOOP skipped: stopped: maintenance");
  });

  test("a one-off --once run starts no self-update", async () => {
    const d = new World().deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate: { auto: true } }));
    const r = await oneLoopPass(d, ["--once"]);
    expect(r.code).toBe(0);
    expect(r.started).toBe(0);
  });
});

describe("dori duty", () => {
  test("a stop request ends the loop after the pass, without waiting out the interval", async () => {
    const d = new World().deps();
    const r = await captured(() => runDuty(d, parse(["duty", "--interval", "1000000"]), undefined, stopAfterPass));
    expect(r.value).toBe(0);
    expect(r.lines.join("\n")).toContain("DUTY STOPPED by SIGTERM after this pass");
  });
});
