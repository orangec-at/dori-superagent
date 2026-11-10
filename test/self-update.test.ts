import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUpdate, type RestartTarget, selfUpdate, type SelfUpdateIo } from "../src/self-update.ts";
import { gitWorld, runnerIn, sh } from "./self-update-git.ts";

const ROLES: RestartTarget[] = [
  { kind: "service", name: "dori-serve" },
  { kind: "role", name: "duty-loop" },
  { kind: "role", name: "hourly-loop" },
];

const NO_INSTALL = ["true"];

afterEach(() => {
  delete process.env["HERDR_PANE_ID"];
  delete process.env["DORI_HOME"];
});

/** An install command that succeeds on every run but the nth, so the checkout install can fail after a green worktree. */
function installFailingOn(nth: number): string[] {
  const counter = join(tmpdir(), `dori-install-${randomUUID()}`);
  return [
    "sh",
    "-c",
    `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ "$n" != ${nth} ]`,
  ];
}

function io(checkout: string): SelfUpdateIo & { told: string[]; restarted: string[] } {
  const told: string[] = [];
  const restarted: string[] = [];
  return {
    run: runnerIn(checkout),
    restart: async (t) => {
      restarted.push(`${t.kind}:${t.name}`);
    },
    tell: async (text) => {
      told.push(text);
    },
    told,
    restarted,
  };
}

describe("checkUpdate", () => {
  test("current, then behind by the commits pushed to origin's default branch", async () => {
    const g = await gitWorld();
    const run = runnerIn(g.checkout);
    expect((await checkUpdate(run)).state).toBe("current");
    await g.push("a.txt");
    const target = await g.push("b.txt");
    const s = await checkUpdate(run);
    expect(s).toMatchObject({ state: "behind", behind: 2, target, upstream: "origin/main" });
  });

  test("a local commit is diverged and a tracked edit is dirty: neither can be fast-forwarded", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    appendFileSync(join(g.checkout, "prompts", "lead.md"), "- machine rule\n");
    expect(await checkUpdate(runnerIn(g.checkout))).toMatchObject({ state: "dirty", files: ["prompts/lead.md"] });
    await sh(g.checkout, "git", "commit", "--quiet", "-am", "local");
    expect((await checkUpdate(runnerIn(g.checkout))).state).toBe("diverged");
  });

  test("a checked-out branch other than the default is off-branch; a detached HEAD can still be fast-forwarded", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    await sh(g.checkout, "git", "checkout", "--quiet", "-b", "experiment");
    expect(await checkUpdate(runnerIn(g.checkout))).toMatchObject({ state: "off-branch", branch: "experiment" });
    const r = await selfUpdate(io(g.checkout), { checks: [["true"]], restarts: [], install: NO_INSTALL });
    expect(r.outcome).toBe("refused");
    await sh(g.checkout, "git", "checkout", "--quiet", "--detach");
    expect((await checkUpdate(runnerIn(g.checkout))).state).toBe("behind");
  });

  test("an untracked file does not make the checkout dirty", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    writeFileSync(join(g.checkout, "scratch.txt"), "x");
    expect((await checkUpdate(runnerIn(g.checkout))).state).toBe("behind");
  });
});

describe("selfUpdate", () => {
  test("green checks: fast-forwards, restarts services, duty loop and hourly loop in order, tells old..new", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    const target = await g.push("a.txt");
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["true"]], restarts: ROLES, install: NO_INSTALL });
    expect(r.outcome).toBe("updated");
    expect(r.status).toMatchObject({ head: old, target });
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(target);
    expect(x.restarted).toEqual(["service:dori-serve", "role:duty-loop", "role:hourly-loop"]);
    expect(x.told).toEqual([`[SELF-UPDATE] ${old.slice(0, 7)}..${target.slice(0, 7)}`]);
  });

  test("the checks run in a throwaway worktree, not in the checkout, and leave no worktree behind", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    const target = await g.push("a.txt");
    const x = io(g.checkout);
    const seen = join(tmpdir(), `dori-seen-${randomUUID()}`);
    const r = await selfUpdate(x, {
      checks: [["sh", "-c", `git rev-parse HEAD > ${seen}; test -f a.txt`]],
      restarts: ROLES,
      install: NO_INSTALL,
    });
    expect(r.outcome).toBe("updated");
    // The checks saw the target commit while the checkout was still on the old one.
    expect((await sh(g.checkout, "cat", seen)).trim()).toBe(target);
    expect(await sh(g.checkout, "git", "worktree", "list", "--porcelain")).not.toContain("dori-self-update-");
    expect(old).not.toBe(target);
  });

  test("a failing check never moves the checkout and restarts nothing", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    await g.push("a.txt");
    const x = io(g.checkout);
    const r = await selfUpdate(x, {
      checks: [["true"], ["sh", "-c", "echo 3 tests failed; exit 1"]],
      restarts: ROLES,
      install: NO_INSTALL,
    });
    expect(r.outcome).toBe("unproven");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(old);
    expect(await sh(g.checkout, "git", "status", "--porcelain")).toBe("");
    expect(x.restarted).toEqual([]);
    expect(x.told).toHaveLength(1);
    expect(x.told[0]).toContain(`still at ${old.slice(0, 7)}`);
    expect(x.told[0]).toContain("3 tests failed");
    expect(await sh(g.checkout, "git", "worktree", "list", "--porcelain")).not.toContain("dori-self-update-");
    expect((await checkUpdate(runnerIn(g.checkout))).state).toBe("behind");
  });

  test("a failing install in the worktree is reported and nothing is touched", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    await g.push("a.txt");
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["true"]], restarts: ROLES, install: installFailingOn(1) });
    expect(r.outcome).toBe("unproven");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(old);
    expect(x.told[0]).toContain("in the verification worktree failed");
  });

  test("bun.lock changed: the checkout is installed too, and a failure there rolls the branch back", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    await g.push("bun.lock");
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["true"]], restarts: ROLES, install: installFailingOn(2) });
    expect(r.outcome).toBe("rolled-back");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(old);
    expect(await sh(g.checkout, "git", "status", "--porcelain")).toBe("");
    expect(x.restarted).toEqual([]);
    expect(x.told[0]).toContain(`rolled back to ${old.slice(0, 7)}`);
    expect((await checkUpdate(runnerIn(g.checkout))).state).toBe("behind");
  });

  test("a dirty checkout is refused untouched and the reason is told", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    await g.push("a.txt");
    appendFileSync(join(g.checkout, "prompts", "lead.md"), "- machine rule\n");
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["true"]], restarts: ROLES, install: NO_INSTALL });
    expect(r.outcome).toBe("refused");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(old);
    expect(await sh(g.checkout, "git", "diff", "--name-only")).toBe("prompts/lead.md");
    expect(x.restarted).toEqual([]);
    expect(x.told[0]).toContain("refused: SELF_UPDATE_DIRTY local changes in prompts/lead.md");
  });

  test("a current checkout runs nothing and tells nobody", async () => {
    const g = await gitWorld();
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["false"]], restarts: ROLES, install: ["false"] });
    expect(r.outcome).toBe("current");
    expect(x.told).toEqual([]);
    expect(x.restarted).toEqual([]);
  });

  test("the install and the checks see no live DORI_HOME and no HERDR_* variable", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    const seen = join(tmpdir(), `dori-env-${randomUUID()}`);
    process.env["HERDR_PANE_ID"] = "w1:p1";
    process.env["DORI_HOME"] = "/live/dori/home";
    const x = io(g.checkout);
    const r = await selfUpdate(x, {
      checks: [["sh", "-c", `{ echo "home=$DORI_HOME"; env | grep -c '^HERDR_' || true; } > ${seen}`]],
      restarts: [],
      install: NO_INSTALL,
    });
    expect(r.outcome).toBe("updated");
    const text = readFileSync(seen, "utf8");
    expect(text).not.toContain("/live/dori/home");
    expect(text).toContain("home=");
    expect(text.trim().split("\n").at(-1)).toBe("0");
  });

  test("a worktree left by a dead run is removed; one a live run is checking in is kept", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    // pid_max on Linux is at most 4194304, so this pid can never be alive.
    const dead = join(tmpdir(), `dori-self-update-abc1234-2147483646-${randomUUID()}`);
    const live = join(tmpdir(), `dori-self-update-abc1234-${process.pid}-${randomUUID()}`);
    await sh(g.checkout, "git", "worktree", "add", "--detach", "--quiet", dead, "HEAD");
    await sh(g.checkout, "git", "worktree", "add", "--detach", "--quiet", live, "HEAD");
    const r = await selfUpdate(io(g.checkout), { checks: [["true"]], restarts: [], install: NO_INSTALL });
    expect(r.outcome).toBe("updated");
    const list = await sh(g.checkout, "git", "worktree", "list", "--porcelain");
    expect(existsSync(dead)).toBe(false);
    expect(list).not.toContain(dead);
    expect(list).toContain(live);
    await sh(g.checkout, "git", "worktree", "remove", "--force", live);
  });

  test("a restart that fails is reported in the line; the other restarts still run", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    const x = io(g.checkout);
    const failing: SelfUpdateIo = {
      ...x,
      restart: async (t) => {
        if (t.name === "duty-loop") throw new Error("no dori duty process");
        await x.restart(t);
      },
    };
    const r = await selfUpdate(failing, { checks: [["true"]], restarts: ROLES, install: NO_INSTALL });
    expect(r).toMatchObject({ outcome: "updated", restartFailures: ["role duty-loop: no dori duty process"] });
    expect(x.restarted).toEqual(["service:dori-serve", "role:hourly-loop"]);
    expect(x.told[0]).toContain("restart failed: role duty-loop: no dori duty process");
  });
});
