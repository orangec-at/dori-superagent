import { describe, expect, test } from "bun:test";
import { RESTART_WAIT_MS, restartCommand, restartRole } from "../src/self-update-run.ts";
import { href, World } from "./fake.ts";

describe("restartRole", () => {
  const loopArgv = (sub: string) => ["bun", "/repo/src/cli.ts", sub, ...(sub === "duty" ? ["--interval", "60"] : [])];

  test("stops the dori process in front of each loop pane and types dori up's command back in", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p7", "shell").foreground = [{ name: "bun", argv: loopArgv("duty") }];
    w.addPane("w1:p8", "shell").foreground = [{ name: "bun", argv: loopArgv("loop") }];
    d.store.setRole("duty-loop", href("w1:p7"));
    d.store.setRole("hourly-loop", href("w1:p8"));
    const killed: number[] = [];
    const procs = { kill: (pid: number) => void killed.push(pid), alive: () => false, sleep: async () => {} };
    await restartRole(d, "duty-loop", procs);
    await restartRole(d, "hourly-loop", procs);
    expect(killed).toEqual([101, 101]);
    expect(w.panes.get("w1:p7")!.ran).toEqual([`${d.doriCmd} duty --interval 60`]);
    expect(w.panes.get("w1:p8")!.ran).toEqual([`${d.doriCmd} loop`]);
  });

  test("a loop role on another machine is not signalled: its pids would name local processes", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p8", "shell").foreground = [{ name: "bun", argv: loopArgv("loop") }];
    d.store.setRole("hourly-loop", { ...href("w1:p8"), machine: "ubuntu" });
    const killed: number[] = [];
    const procs = { kill: (pid: number) => void killed.push(pid), alive: () => false, sleep: async () => {} };
    await expect(restartRole(d, "hourly-loop", procs)).rejects.toThrow(
      "is on machine ubuntu; restart dori loop there by hand",
    );
    expect(killed).toEqual([]);
    expect(w.panes.get("w1:p8")!.ran).toEqual([]);
  });

  test("a pane whose processes cannot be read is not typed into: the old loop may still be in front", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p8", "shell").foreground = [{ name: "bun", argv: loopArgv("loop") }];
    d.store.setRole("hourly-loop", href("w1:p8"));
    w.processInfoFails = true;
    const killed: number[] = [];
    const procs = { kill: (pid: number) => void killed.push(pid), alive: () => false, sleep: async () => {} };
    await expect(restartRole(d, "hourly-loop", procs)).rejects.toThrow("cannot read the processes of");
    expect(killed).toEqual([]);
    expect(w.panes.get("w1:p8")!.ran).toEqual([]);
  });

  test("a loop started by hand comes back with its own flags, without --force", async () => {
    const w = new World();
    const d = w.deps();
    const argv = ["bun", "/repo/src/cli.ts", "loop", "--max-lanes", "4", "--force", "--max-load", "6.5"];
    w.addPane("w1:p8", "shell").foreground = [{ name: "bun", argv }];
    d.store.setRole("hourly-loop", href("w1:p8"));
    await restartRole(d, "hourly-loop", { kill: () => {}, alive: () => false, sleep: async () => {} });
    expect(w.panes.get("w1:p8")!.ran).toEqual([`${d.doriCmd} loop --max-lanes 4 --max-load 6.5`]);
    expect(restartCommand("dori", ["bun", "/r/cli.ts", "duty", "--interval", "a b"])).toBe(
      "dori duty --interval 'a b'",
    );
  });

  test("a loop still in a long pass after SIGTERM is waited for, then started again", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p8", "shell").foreground = [{ name: "bun", argv: loopArgv("loop") }];
    d.store.setRole("hourly-loop", href("w1:p8"));
    // The pass ends after three minutes of polling: far past the old 10 s limit, well inside RESTART_WAIT_MS.
    let slept = 0;
    const procs = {
      kill: () => {},
      alive: () => slept < 3 * 60_000,
      sleep: async (ms: number) => {
        slept += ms;
      },
    };
    await restartRole(d, "hourly-loop", procs);
    expect(slept).toBe(3 * 60_000);
    expect(w.panes.get("w1:p8")!.ran).toEqual([`${d.doriCmd} loop`]);
  });

  test("a pane running something else is not touched; a pass that outlasts the wait names the command to run", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p7", "idle").foreground = [{ name: "vim", argv: ["vim", "notes"] }];
    w.addPane("w1:p8", "shell").foreground = [{ name: "bun", argv: loopArgv("loop") }];
    d.store.setRole("duty-loop", href("w1:p7"));
    d.store.setRole("hourly-loop", href("w1:p8"));
    let slept = 0;
    const procs = {
      kill: () => {},
      alive: () => true,
      sleep: async (ms: number) => {
        slept += ms;
      },
    };
    await expect(restartRole(d, "duty-loop", procs)).rejects.toThrow("no dori duty process in front of");
    const failed = restartRole(d, "hourly-loop", procs);
    await expect(failed).rejects.toThrow("is still finishing its pass");
    await expect(failed).rejects.toThrow(`start it again by hand with ${d.doriCmd} loop`);
    expect(slept).toBe(RESTART_WAIT_MS);
    expect(w.panes.get("w1:p7")!.ran).toEqual([]);
    expect(w.panes.get("w1:p8")!.ran).toEqual([]);
  });
});
