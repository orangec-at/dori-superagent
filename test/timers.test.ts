import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { Store } from "../src/store.ts";
import { addTimer, loadTimers, parseAt, parseEvery } from "../src/timers.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
const timerLines = (received: readonly string[]) => received.filter((m) => m.includes("[TIMER "));

describe("follow-up timers", () => {
  test("a one-off timer reaches the lead once when due, never before and never again", async () => {
    const { w, d, lead } = setup();
    addTimer(d, "check-ci", w.clock + 30 * MIN, "is CI green on #42?");
    w.clock += 29 * MIN;
    await dutyTick(d);
    expect(timerLines(lead.received)).toEqual([]);
    w.clock += MIN;
    expect(await dutyTick(d)).toContainEqual({ pane: "lead", action: "timer-fired", detail: "check-ci" });
    w.clock += 10 * MIN;
    await dutyTick(d);
    expect(timerLines(lead.received)).toEqual([expect.stringContaining("[TIMER check-ci] is CI green on #42?")]);
    expect(loadTimers(d.store.root)[0]?.status).toBe("done");
  });

  test("an overdue timer is delivered after a restart, read back from DORI_HOME", async () => {
    const { w, d, lead } = setup();
    addTimer(d, "after-restart", w.clock + 5 * MIN, "look at the deploy");
    w.clock += 60 * MIN;
    const restarted = { ...d, store: new Store(d.store.root) };
    await dutyTick(restarted);
    await dutyTick(restarted);
    expect(timerLines(lead.received)).toEqual([expect.stringContaining("[TIMER after-restart] look at the deploy")]);
  });

  test("a repeating timer fires once per period and skips the periods missed while down", async () => {
    const { w, d, lead } = setup();
    const start = w.clock;
    addTimer(d, "daily", start + MIN, "daily check", parseEvery("1h"));
    w.clock = start + MIN;
    await dutyTick(d);
    w.clock = start + 3 * 60 * MIN + 5 * MIN;
    await dutyTick(d);
    await dutyTick(d);
    expect(timerLines(lead.received)).toHaveLength(2);
    const t = loadTimers(d.store.root)[0]!;
    expect(t.status).toBe("pending");
    expect(t.at).toBe(start + MIN + 4 * 60 * MIN);
  });

  test("no lead registered: the timer stays pending until there is one", async () => {
    const { w, d } = setup();
    writeFileSync(join(d.store.root, "roles.json"), "{}\n");
    addTimer(d, "waits", w.clock, "later");
    expect(await dutyTick(d)).not.toContainEqual(expect.objectContaining({ action: "timer-fired" }));
    expect(loadTimers(d.store.root)[0]?.status).toBe("pending");
  });

  test("cli: add, list and cancel; a cancelled timer never fires", async () => {
    const { w, d, lead } = setup();
    expect(await main(["timer", "add", "pr-check", "--at", "+30m", "--text", "check PR"], d)).toBe(0);
    expect(loadTimers(d.store.root)[0]?.at).toBe(w.clock + 30 * MIN);
    expect(await main(["timer", "list"], d)).toBe(0);
    expect(await main(["timer", "cancel", "pr-check"], d)).toBe(0);
    w.clock += 60 * MIN;
    await dutyTick(d);
    expect(timerLines(lead.received)).toEqual([]);
    expect(() => addTimer(d, "Bad Id", w.clock, "x")).toThrow("timer id");
  });

  test("parses --at as ISO or +delay and refuses bad specs", () => {
    expect(parseAt("+90s", 1000)).toBe(91_000);
    expect(parseAt("2026-11-17T09:00:00+09:00", 0)).toBe(Date.parse("2026-11-17T00:00:00Z"));
    expect(() => parseAt("tomorrow", 0)).toThrow("--at");
    expect(() => parseEvery("30s")).toThrow("--every");
    expect(() => parseEvery("0 9 * * *")).toThrow("--every");
  });
});
