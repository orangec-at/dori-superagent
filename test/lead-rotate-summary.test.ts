import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hooksSettled } from "../src/hooks.ts";
import { leadRotationTick } from "../src/lead-rotate.ts";
import { rotationLog } from "../src/lead-rotate-state.ts";
import { dayKey } from "../src/lead-rotate-summary.ts";
import { setup } from "./harness-setup.ts";

function rig() {
  const s = setup();
  writeFileSync(
    join(s.d.store.root, "config.json"),
    JSON.stringify({ hooks: { onLeadRotation: ["notify", "{text}"] }, leadRotation: { notify: "daily" } }),
  );
  mkdirSync(dirname(rotationLog(s.d.store.root)), { recursive: true });
  const notified: string[] = [];
  s.w.reviewer = (argv) => {
    notified.push(argv.join(" "));
    return { code: 0, stdout: "" };
  };
  return { ...s, notified };
}

describe("lead rotation notices (#8)", () => {
  test("notify daily: one hook line a day sums up the rotations of the day before", async () => {
    const { w, d, notified } = rig();
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
    const row = (ms: number, line: string) => `${new Date(ms).toISOString()} ${line}\n`;
    writeFileSync(
      rotationLog(d.store.root),
      row(at(17, 10), "[LEAD ROTATED] w1:p1: context 310K >= 300K; handoff /h/0.md") +
        row(at(18, 9), "[LEAD ROTATED] w1:p1: context 305K >= 300K; handoff /h/1.md") +
        row(at(18, 15), "[LEAD ROTATE TIMEOUT] w1:p1: no handoff at /h/2.md after 15 min") +
        row(at(18, 23), "[LEAD ROTATED] w1:p1: context 442K >= 300K; handoff /h/3.md") +
        row(at(19, 1), "[LEAD ROTATED] w1:p1: context 320K >= 300K; handoff /h/4.md"),
    );
    w.clock = at(19, 9);
    await leadRotationTick(d);
    await hooksSettled();
    expect(notified).toEqual([`[LEAD ROTATIONS] ${dayKey(at(18, 9))}: 2 lead rotations; ${rotationLog(d.store.root)}`]);
    w.clock = at(19, 18);
    await leadRotationTick(d);
    w.clock = at(20, 9);
    await leadRotationTick(d);
    await hooksSettled();
    expect(notified.slice(1)).toEqual([expect.stringContaining(`${dayKey(at(19, 1))}: 1 lead rotation;`)]);
  });
});
