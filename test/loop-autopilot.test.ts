import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Assignment, autopilotDir, recordAssignment, writeJson } from "../src/autopilot-store.ts";
import { HOUR } from "../src/loop.ts";
import { setup } from "./loop-setup.ts";

const loopMsg = (received: string[]): string => received.filter((m) => m.startsWith("[LOOP")).at(-1)!;
const autopilotLine = (msg: string): string | undefined => msg.split("\n").find((l) => l.startsWith("autopilot "));

describe("hourly loop report: autopilot line", () => {
  test("counts the last hour's hand-outs, check-offs and failures, and names the projects marked stalled", async () => {
    const { w, d, lead, tick } = setup();
    const home = d.store.root;
    w.clock += 2 * HOUR;
    const now = w.clock;
    const a = (at: number, kind: Assignment["kind"], project = "alpha"): Assignment => ({
      at,
      project,
      task: `t${at}`,
      text: "task",
      reason: "idle",
      kind,
    });
    recordAssignment(home, a(now - 2 * HOUR, "delegate"));
    recordAssignment(home, a(now - 30 * 60_000, "delegate"));
    recordAssignment(home, a(now - 20 * 60_000, "backlog"));
    recordAssignment(home, a(now - 10 * 60_000, "completed"));
    recordAssignment(home, a(now - 5 * 60_000, "release"));
    writeJson(home, "state.json", {
      activity: {},
      stallReportedAt: { beta: now - 3 * HOUR, gamma: now - 25 * HOUR, alpha: now - HOUR },
    });
    await tick();
    expect(autopilotLine(loopMsg(lead.received))).toBe(
      "autopilot 1h: assigned 2, completed 1, failed 1 | stalled: alpha, beta",
    );
  });

  test("an hour with no hand-outs still gets the line", async () => {
    const { w, d, lead, tick } = setup();
    w.clock += 2 * HOUR;
    recordAssignment(d.store.root, {
      at: w.clock - 3 * HOUR,
      project: "alpha",
      task: "t1",
      text: "task",
      reason: "idle",
      kind: "delegate",
    });
    await tick();
    expect(autopilotLine(loopMsg(lead.received))).toBe(
      "autopilot 1h: assigned 0, completed 0, failed 0 | stalled: none",
    );
  });

  test("no autopilot record: the line is left out and the report goes out as before", async () => {
    const { d, lead, tick } = setup();
    const run = await tick();
    const msg = loopMsg(lead.received);
    expect(msg).toContain("lanes 0/3");
    expect(autopilotLine(msg)).toBeUndefined();
    expect(d.store.lastRun()!.at).toBe(run.at);
  });

  test("broken lines in assignments.jsonl are skipped and the good ones still counted", async () => {
    const { w, d, lead, tick } = setup();
    w.clock += 2 * HOUR;
    const home = d.store.root;
    const good = { at: w.clock - 60_000, project: "alpha", task: "t1", text: "task", reason: "idle", kind: "delegate" };
    mkdirSync(autopilotDir(home), { recursive: true });
    appendFileSync(
      join(autopilotDir(home), "assignments.jsonl"),
      [
        JSON.stringify(good),
        "{not json",
        "42",
        JSON.stringify({ ...good, at: "yesterday" }),
        JSON.stringify({ ...good, kind: "mystery" }),
        JSON.stringify({ ...good, task: "t2", kind: "completed" }),
        "",
      ].join("\n"),
    );
    await tick();
    expect(autopilotLine(loopMsg(lead.received))).toBe(
      "autopilot 1h: assigned 1, completed 1, failed 0 | stalled: none",
    );
  });

  test("an unreadable record leaves the line out without stopping the loop; a stop file is shown", async () => {
    const broken = setup();
    mkdirSync(join(autopilotDir(broken.d.store.root), "assignments.jsonl"), { recursive: true });
    const run = await broken.tick();
    expect(run.skipped).toBeUndefined();
    expect(autopilotLine(loopMsg(broken.lead.received))).toBeUndefined();

    const stopped = setup();
    stopped.w.clock += 2 * HOUR;
    recordAssignment(stopped.d.store.root, {
      at: stopped.w.clock - 2 * HOUR,
      project: "alpha",
      task: "t1",
      text: "task",
      reason: "idle",
      kind: "delegate",
    });
    appendFileSync(join(autopilotDir(stopped.d.store.root), "stop"), "");
    await stopped.tick();
    expect(autopilotLine(loopMsg(stopped.lead.received))).toBe(
      "autopilot 1h (stopped): assigned 0, completed 0, failed 0 | stalled: none",
    );
  });
});
