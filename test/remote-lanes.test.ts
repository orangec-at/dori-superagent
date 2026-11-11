import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { done, ready, startLane } from "../src/lanes.ts";
import { inboxFile, inboxRefs } from "../src/inbox-files.ts";
import { refFromText, refText, sameSession } from "../src/refs.ts";
import { dutyTick, NUDGE_MINUTES } from "../src/duty.ts";
import { adoptLane } from "../src/adopt.ts";
import { migrate } from "../src/migrate.ts";
import { formatRef, parseRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { ref, world } from "./herdr-recorder.ts";

const saved = { host: process.env["DORI_SSH_HOST"], path: process.env["DORI_REMOTE_PATH"] };
beforeEach(() => {
  process.env["DORI_SSH_HOST"] = "fedora";
  process.env["DORI_REMOTE_PATH"] = "/opt/bin";
});
afterEach(() => {
  for (const [k, v] of [
    ["DORI_SSH_HOST", saved.host],
    ["DORI_REMOTE_PATH", saved.path],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe("session refs with a machine", () => {
  test("parse, print and compare w4:p3@ubuntu; a bad label or an hc ref with one is no ref", () => {
    const remote = { runtime: "herdr", id: "w4:p3", machine: "ubuntu" } as const;
    expect(parseRef("w4:p3@ubuntu")).toEqual(remote);
    expect(parseRef("herdr:w4:p3@ubuntu")).toEqual(remote);
    expect(refText(remote)).toBe("w4:p3@ubuntu");
    expect(formatRef(remote)).toBe("herdr:w4:p3@ubuntu");
    expect(refFromText("w4:p3@ubuntu")).toEqual(remote);
    expect(sameSession(remote, href("w4:p3"))).toBe(false);
    for (const bad of ["w4:p3@", "w4:p3@a_b", "w4:p3@a@b", "hc:t7@ubuntu", "w4:p3@a/b"])
      expect(parseRef(bad)).toBeUndefined();
  });

  test("a remote pane has its own inbox file, read back with its machine", () => {
    const { d } = setup();
    const remote = { runtime: "herdr", id: "w4:p3", machine: "ubuntu" } as const;
    d.store.enqueue(remote, { at: 1, from: "cli", text: "hi" });
    expect(inboxFile(d.store.root, remote)).toEndWith("/inbox/w4_p3@ubuntu.jsonl");
    expect(inboxRefs(d.store.root)).toContainEqual(remote);
    expect(d.store.queued(href("w4:p3"))).toEqual([]);
  });
});

describe("herdr --machine", () => {
  test("every call for a remote ref carries --machine and no --session; a local ref carries neither", async () => {
    const { w, rt, herdr } = world();
    w.addPane("w4:p3", "idle").screen = "❯";
    const remote = { ...ref("w4:p3"), machine: "mini" };
    await rt.probe(remote);
    await rt.read(remote, 5);
    await rt.deliver(remote, "hello");
    await rt.close(remote);
    const calls = herdr();
    expect(calls.length).toBeGreaterThan(3);
    for (const argv of calls) expect(argv.slice(0, 2)).toEqual(["--machine", "mini"]);
    w.addPane("w1:p1", "idle");
    await rt.probe(ref("w1:p1"));
    expect(herdr().at(-1)?.[0]).not.toBe("--machine");
  });
});

describe("dori start --machine", () => {
  test("opens a dori workspace and tab on the machine; brief and rules go over ssh to this host", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "ios-fix", brief, { machine: "mini", cwd: "/Users/mac/app" });
    expect(lane.sessionRef.machine).toBe("mini");
    const opening = w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "--machine");
    expect(opening.map((c) => c.argv.slice(2, 4).join(" "))).toEqual(["workspace create", "tab create", "pane run"]);
    expect(opening[1]!.argv).toContain("/Users/mac/app");
    expect(opening[1]!.argv.join(" ")).not.toContain("DORI_HOME=");
    expect(w.panes.get(lane.paneId)!.ran[0]).toContain("ssh fedora cat ");
    const rules = await Bun.file(lane.brief).text();
    expect(rules).toContain("| ssh fedora 'PATH=/opt/bin:$PATH dori' report ios-fix");
    expect(rules).toContain(`| ssh fedora 'PATH=/opt/bin:$PATH dori' ready ios-fix --evidence "'<link>'"`);
    expect(lead.received).toEqual([`[START ios-fix] lane opened in ${lane.paneId}@mini`]);
  });

  test("refuses a remote lane without --cwd, and on hc", async () => {
    const { d, brief } = setup();
    await expect(startLane(d, "ios-fix", brief, { machine: "mini" })).rejects.toThrow("--machine needs --cwd");
    const hc = setup({ runtime: "hc" });
    await expect(startLane(hc.d, "ios-fix", hc.brief, { machine: "mini", cwd: "/x" })).rejects.toThrow("herdr runtime");
  });

  test("duty nudges a silent remote lane in the ssh form; done closes its pane on the machine", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "ios-fix", brief, { machine: "mini", cwd: "/w" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    w.clock += (NUDGE_MINUTES[0] + 1) * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "ios-fix", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("| ssh fedora 'PATH=/opt/bin:$PATH dori' report ios-fix --status waiting");
    await ready(d, "ios-fix", "built", ["https://github.com/o/r/pull/9"]);
    expect(lead.received.at(-1)).toStartWith("[READY ios-fix]");
    await done(d, "ios-fix");
    expect(w.calls.at(-1)?.argv).toEqual(["--machine", "mini", "pane", "close", lane.paneId]);
  });

  test("dori migrate refuses a remote or adopted lane, and --all skips them, closing and opening nothing", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "ios-fix", brief, { machine: "mini", cwd: "/w" });
    w.addPane("w6:p1", "idle");
    await adoptLane(d, "vibeguard", "w6:p1");
    const lines: string[] = [];
    const opts = {
      to: "hc" as const,
      dryRun: false,
      waitMinutes: 0,
      resume: false,
      sleep: async () => {},
      log: (l: string) => void lines.push(l),
    };
    const before = w.calls.length;
    await expect(migrate(d, { lane: "ios-fix" }, opts)).rejects.toThrow("runs on machine mini");
    await expect(migrate(d, { lane: "vibeguard" }, opts)).rejects.toThrow("adopted lane");
    await migrate(d, { all: true }, { ...opts, dryRun: true });
    expect(lines.filter((l) => l.startsWith("SKIP "))).toEqual([
      "SKIP ios-fix runs on machine mini: migrate moves only this machine's sessions",
      "SKIP vibeguard adopted lane: its pane is the operator's",
    ]);
    expect(w.calls.slice(before).some((c) => c.argv.includes("close") || c.argv.includes("create"))).toBe(false);
    expect(w.panes.has("w6:p1")).toBe(true);
  });
});
