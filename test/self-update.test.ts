import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkUpdate, type RestartTarget, selfUpdate, type SelfUpdateIo } from "../src/self-update.ts";
import { gitWorld, runnerIn, sh } from "./self-update-git.ts";

const ROLES: RestartTarget[] = [
  { kind: "service", name: "dori-serve" },
  { kind: "role", name: "duty-loop" },
  { kind: "role", name: "hourly-loop" },
];

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
    const r = await selfUpdate(x, { checks: [["true"]], restarts: ROLES });
    expect(r.outcome).toBe("updated");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(target);
    expect(x.restarted).toEqual(["service:dori-serve", "role:duty-loop", "role:hourly-loop"]);
    expect(x.told).toEqual([`[SELF-UPDATE] ${old.slice(0, 7)}..${target.slice(0, 7)}`]);
  });

  test("a failing check goes back to the old HEAD and restarts nothing", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    await g.push("a.txt");
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["true"], ["sh", "-c", "echo 3 tests failed; exit 1"]], restarts: ROLES });
    expect(r.outcome).toBe("rolled-back");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(old);
    expect(await sh(g.checkout, "git", "status", "--porcelain")).toBe("");
    expect(x.restarted).toEqual([]);
    expect(x.told).toHaveLength(1);
    expect(x.told[0]).toContain(`rolled back to ${old.slice(0, 7)}`);
    expect(x.told[0]).toContain("3 tests failed");
  });

  test("a rollback also moves a checked-out branch back, so the next check sees the same commit as behind", async () => {
    const g = await gitWorld();
    await g.push("a.txt");
    await selfUpdate(io(g.checkout), { checks: [["false"]], restarts: ROLES });
    expect((await checkUpdate(runnerIn(g.checkout))).state).toBe("behind");
  });

  test("a dirty checkout is refused untouched and the reason is told", async () => {
    const g = await gitWorld();
    const old = await sh(g.checkout, "git", "rev-parse", "HEAD");
    await g.push("a.txt");
    appendFileSync(join(g.checkout, "prompts", "lead.md"), "- machine rule\n");
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["true"]], restarts: ROLES });
    expect(r.outcome).toBe("refused");
    expect(await sh(g.checkout, "git", "rev-parse", "HEAD")).toBe(old);
    expect(await sh(g.checkout, "git", "diff", "--name-only")).toBe("prompts/lead.md");
    expect(x.restarted).toEqual([]);
    expect(x.told[0]).toContain("refused: SELF_UPDATE_DIRTY local changes in prompts/lead.md");
  });

  test("a current checkout runs nothing and tells nobody", async () => {
    const g = await gitWorld();
    const x = io(g.checkout);
    const r = await selfUpdate(x, { checks: [["false"]], restarts: ROLES });
    expect(r.outcome).toBe("current");
    expect(x.told).toEqual([]);
    expect(x.restarted).toEqual([]);
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
    const r = await selfUpdate(failing, { checks: [["true"]], restarts: ROLES });
    expect(r).toMatchObject({ outcome: "updated", restartFailures: ["role duty-loop: no dori duty process"] });
    expect(x.restarted).toEqual(["service:dori-serve", "role:hourly-loop"]);
    expect(x.told[0]).toContain("restart failed: role duty-loop: no dori duty process");
  });
});
