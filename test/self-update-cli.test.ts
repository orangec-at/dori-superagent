import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/cli-args.ts";
import { main } from "../src/cli.ts";
import { runSelfUpdate } from "../src/cli-self-update.ts";
import type { Deps } from "../src/harness.ts";
import { acquire } from "../src/loop-lock.ts";
import { checkUpdate } from "../src/self-update.ts";
import {
  MAX_SELF_UPDATE_FAILURES,
  afterMerge,
  originRepo,
  rememberFailure,
  restartTargets,
  selfUpdateIo,
  situation,
} from "../src/self-update-run.ts";
import { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { gitWorld, runnerIn, sh } from "./self-update-git.ts";

afterEach(() => {
  delete process.env["DORI_SELF_UPDATE"];
});

const lines: string[] = [];
function capture(): () => void {
  lines.length = 0;
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  return () => log.mockRestore();
}

const configure = (d: Deps, selfUpdate: Record<string, unknown>): void =>
  writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate }));

const memo = (d: Deps): { situation?: string; failures?: number } =>
  JSON.parse(readFileSync(join(d.store.root, "self-update.json"), "utf8"));

describe("dori self-update", () => {
  test("one self-update per home: a held lock is refused", async () => {
    const g = await gitWorld();
    const d = new World().deps();
    acquire(d, `${d.store.root}/self-update.lock`);
    await expect(runSelfUpdate(d, parse(["self-update"]), runnerIn(g.checkout))).rejects.toThrow(
      "another self-update runs in this home",
    );
  });

  test("a situation that failed enough times is skipped, --now retries it, and success forgets the failures", async () => {
    const g = await gitWorld();
    const d = new World().deps();
    configure(d, { checks: [["true"]], install: ["true"] });
    const run = runnerIn(g.checkout);
    const target = await g.push("a.txt");
    for (let i = 0; i < MAX_SELF_UPDATE_FAILURES; i++) rememberFailure(d, situation(await checkUpdate(run)));
    const restore = capture();
    try {
      expect(await runSelfUpdate(d, parse(["self-update"]), run)).toBe(1);
      expect(lines.join("\n")).toContain("SELF_UPDATE_SKIPPED");
      expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).not.toBe(target);
      expect(await runSelfUpdate(d, parse(["self-update", "--now"]), run)).toBe(0);
    } finally {
      restore();
    }
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(target);
    expect(memo(d).failures).toBe(0);
  });

  test("a failed run is counted; the switch stops --auto runs only, never a run by hand", async () => {
    const g = await gitWorld();
    const d = new World().deps();
    configure(d, { auto: true, checks: [["false"]], install: ["true"] });
    const run = runnerIn(g.checkout);
    await g.push("a.txt");
    const restore = capture();
    try {
      expect(await runSelfUpdate(d, parse(["self-update", "--auto"]), run)).toBe(1);
      expect(memo(d).failures).toBe(1);
      process.env["DORI_SELF_UPDATE"] = "off";
      expect(await runSelfUpdate(d, parse(["self-update", "--auto"]), run)).toBe(0);
      expect(lines.join("\n")).toContain("SELF_UPDATE_OFF");
      expect(memo(d).failures).toBe(1);
      expect(await runSelfUpdate(d, parse(["self-update"]), run)).toBe(1);
      expect(memo(d).failures).toBe(2);
    } finally {
      restore();
    }
  });

  test("with no config, an --auto run stops before any git call, and a run by hand updates", async () => {
    const g = await gitWorld();
    const d = new World().deps();
    const calls: string[] = [];
    const real = runnerIn(g.checkout);
    const run: typeof real = (cmd, argv, where) => {
      calls.push(cmd);
      return real(cmd, argv, where);
    };
    const target = await g.push("a.txt");
    const restore = capture();
    try {
      expect(await runSelfUpdate(d, parse(["self-update", "--auto"]), run)).toBe(0);
      expect(lines.join("\n")).toContain("SELF_UPDATE_OFF automatic runs are opt-in");
      expect(calls).toEqual([]);
      configure(d, { checks: [["true"]], install: ["true"] });
      expect(await runSelfUpdate(d, parse(["self-update"]), run)).toBe(0);
    } finally {
      restore();
    }
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(target);
  });

  test("a broken config and a failing fetch are told, not just logged", async () => {
    const g = await gitWorld();
    const d = new World().deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate: { services: "dori-serve" } }));
    const restore = capture();
    try {
      expect(await runSelfUpdate(d, parse(["self-update"]), runnerIn(g.checkout))).toBe(1);
      configure(d, { checks: [["true"]], install: ["true"] });
      expect(await runSelfUpdate(d, parse(["self-update"]), runnerIn("/nonexistent-checkout"))).toBe(1);
    } finally {
      restore();
    }
    const errors = lines.filter((l) => l.startsWith("[SELF-UPDATE] error:"));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("selfUpdate.services must be an array of strings");
  });

  test("the same error is told MAX_SELF_UPDATE_FAILURES times, then skipped; --now still tells it", async () => {
    const d = new World().deps();
    configure(d, { checks: [["true"]], install: ["true"] });
    const run = runnerIn("/nonexistent-checkout");
    const restore = capture();
    try {
      for (let i = 0; i < MAX_SELF_UPDATE_FAILURES + 1; i++)
        expect(await runSelfUpdate(d, parse(["self-update"]), run)).toBe(1);
      expect(lines.filter((l) => l.startsWith("[SELF-UPDATE] error:"))).toHaveLength(MAX_SELF_UPDATE_FAILURES);
      expect(lines.filter((l) => l.startsWith("SELF_UPDATE_SKIPPED [SELF-UPDATE] error:"))).toHaveLength(1);
      expect(await runSelfUpdate(d, parse(["self-update", "--now"]), run)).toBe(1);
      expect(lines.filter((l) => l.startsWith("[SELF-UPDATE] error:"))).toHaveLength(MAX_SELF_UPDATE_FAILURES + 1);
    } finally {
      restore();
    }
  });
});

describe("selfUpdateIo", () => {
  test("a service restart runs systemctl --user and a failure carries its reason", async () => {
    const { w, d } = setup();
    const io = selfUpdateIo(d, { auto: true, services: ["dori-serve"], checks: [] });
    w.reviewer = (argv) =>
      argv[0] === "--user" ? { code: 1, stdout: "", stderr: "Unit not found." } : { code: 0, stdout: "" };
    await expect(io.restart(restartTargets({ auto: true, services: ["dori-serve"], checks: [] })[0]!)).rejects.toThrow(
      "Unit not found.",
    );
    expect(w.calls.some((c) => c.cmd === "systemctl" && c.argv.join(" ") === "--user restart dori-serve")).toBe(true);
  });

  test("every told line goes to the notify address; a sender that fails does not throw", async () => {
    const { w, d } = setup();
    const io = selfUpdateIo(d, { auto: true, services: [], checks: [], notify: "discord:12345" });
    const restore = capture();
    try {
      await io.tell("[SELF-UPDATE] abc..def");
      w.reviewer = () => ({ code: 1, stdout: "", stderr: "no webhook" });
      await io.tell("[SELF-UPDATE] second line");
    } finally {
      restore();
    }
    const sent = w.calls.filter((c) => c.cmd === join(d.store.root, "bin", "dori-reply"));
    expect(sent.map((c) => c.argv[0])).toEqual(["12345", "12345"]);
    expect(sent[0]!.argv[1]).toBe("[SELF-UPDATE] abc..def");
  });
});

describe("dori merge and the checkout's origin", () => {
  test("originRepo reads owner/repo from a GitHub remote and ignores any other remote", async () => {
    const g = await gitWorld();
    const run = runnerIn(g.checkout);
    expect(await originRepo(run)).toBeUndefined();
    await sh(g.checkout, "git", "remote", "set-url", "origin", "git@github.com:Orange-At/Dori-Superagent.git");
    expect(await originRepo(run)).toBe("Orange-At/Dori-Superagent");
  });

  test("afterMerge: only a PR of the checkout's own origin (any case) starts the trigger, and it never throws", async () => {
    const g = await gitWorld();
    await sh(g.checkout, "git", "remote", "set-url", "origin", "git@github.com:orangec-at/dori-superagent.git");
    const run = runnerIn(g.checkout);
    const d = new World().deps();
    let started = 0;
    const start = () => void started++;
    expect(await afterMerge(d, "other/repo", run, start)).toBeUndefined();
    expect(await afterMerge(d, "orangec-at/dori-superagent", run, start)).toStartWith("SELF_UPDATE_OFF");
    expect(started).toBe(0);
    configure(d, { auto: true });
    expect(await afterMerge(d, "Orangec-At/Dori-Superagent", run, start)).toStartWith("SELF_UPDATE_STARTED");
    expect(started).toBe(1);
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate: { auto: "yes" } }));
    expect(await afterMerge(d, "orangec-at/dori-superagent", run, start)).toStartWith(
      "SELF_UPDATE_ERROR config.json: selfUpdate.auto must be true or false",
    );
    expect(started).toBe(1);
  });

  test("a merge in another repository still merges and starts no self-update", async () => {
    const { w, d } = setup();
    const head = "a".repeat(40);
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify([{ name: "test", bucket: "pass" }]) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
    d.store.saveReceipt({ pr: "o/r#5", sha: head, verdict: "CLEAR", model: "m", at: d.now(), summary: "" });
    const restore = capture();
    try {
      expect(await main(["merge", "o/r#5"], d)).toBe(0);
    } finally {
      restore();
    }
    expect(lines.join("\n")).toContain(`MERGED o/r#5 head=${head}`);
    expect(lines.join("\n")).not.toContain("SELF_UPDATE");
  });
});
