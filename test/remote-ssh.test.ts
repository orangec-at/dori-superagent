import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { dutyTick, NUDGE_MINUTES } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { doriFor, laneFooter, nudgeText } from "../src/remote.ts";
import { setup } from "./harness-setup.ts";

const KEYS = ["DORI_SSH_HOST", "DORI_REMOTE_PATH"] as const;
const saved = KEYS.map((k) => process.env[k]);
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  KEYS.forEach((k, i) => {
    const v = saved[i];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

describe("remote lane ssh target and PATH", () => {
  test("defaults to <user>@<host> of this machine and the running bun's directory on PATH", () => {
    const { d } = setup();
    const cmd = doriFor(d, "mini");
    expect(cmd).toStartWith(`ssh ${userInfo().username}@${hostname()} 'PATH=`);
    expect(cmd).toContain(`${dirname(process.execPath)}`);
    expect(cmd).toEndWith(`:$PATH dori'`);
    expect(doriFor(d, undefined)).toBe("dori");
  });

  test("config.json remote.ssh and remote.path are rendered into the footer and the nudge", () => {
    const { d } = setup();
    writeFileSync(
      join(d.store.root, "config.json"),
      JSON.stringify({ remote: { ssh: "brady@fedora", path: "/home/brady/.local/bin" } }),
    );
    const dori = "ssh brady@fedora 'PATH=/home/brady/.local/bin:$PATH dori'";
    const footer = laneFooter(d, "k1", "mini");
    expect(footer).toContain(`\`printf '%s\\n' '<milestone>' | ${dori} report k1\``);
    expect(footer).toContain(`| ${dori} ready k1 --evidence "'<link>'"`);
    expect(footer).toContain("runs on `brady@fedora` over ssh");
    const nudge = nudgeText(d, "k1", 12, "mini");
    expect(nudge).toContain(`| ${dori} report k1 --status waiting`);
    expect(nudge).toContain("`bun` or `herdr` not found");
  });

  test("DORI_SSH_HOST and DORI_REMOTE_PATH win over config.json", () => {
    const { d } = setup();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ remote: { ssh: "x@y", path: "/x" } }));
    process.env["DORI_SSH_HOST"] = "brady@10.0.0.5";
    process.env["DORI_REMOTE_PATH"] = "/opt/bun/bin";
    expect(doriFor(d, "mini")).toBe("ssh brady@10.0.0.5 'PATH=/opt/bun/bin:$PATH dori'");
  });

  test("the real dori command keeps its DORI_HOME and cli path inside the ssh quote", () => {
    const { d } = setup();
    process.env["DORI_SSH_HOST"] = "brady@fedora";
    process.env["DORI_REMOTE_PATH"] = "/home/brady/.local/bin";
    const real = { ...d, doriCmd: "DORI_HOME='/home/brady/.dori' bun '/repo/src/cli.ts'" };
    expect(doriFor(real, "mini")).toBe(
      `ssh brady@fedora 'PATH=/home/brady/.local/bin:$PATH DORI_HOME='\\''/home/brady/.dori'\\'' bun '\\''/repo/src/cli.ts'\\'''`,
    );
  });

  test("an escalated remote lane tells the lead its report command may be failing", async () => {
    process.env["DORI_SSH_HOST"] = "brady@fedora";
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "ios-fix", brief, { machine: "mini", cwd: "/w" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    for (const due of NUDGE_MINUTES) {
      w.clock = Math.max(w.clock, lane.createdAt + (due + 1) * 60_000);
      await dutyTick(d);
    }
    expect(lead.received.at(-1)).toContain("[ESCALATE ios-fix]");
    expect(lead.received.at(-1)).toContain("ssh report command may be failing");
  });
});
