// Proving a target commit before dori's own checkout moves to it: install and checks run in a throwaway worktree,
// under an environment that cannot reach the live home or panes.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "./runtime/exec.ts";
import type { Runner, SelfUpdateIo, SelfUpdateOpts } from "./self-update.ts";

export const DEFAULT_INSTALL: readonly string[] = ["bun", "install", "--frozen-lockfile"];

export const short = (sha: string): string => sha.slice(0, 7);
export const tail = (r: ExecResult, n = 15): string =>
  `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-n).join("\n") || `exit ${r.code}`;

/** Runs the checks in order; the first failure is returned with the tail of its output. */
async function runChecks(
  run: Runner,
  checks: SelfUpdateOpts["checks"],
  where: { cwd: string; env: Record<string, string> },
): Promise<string | undefined> {
  for (const [cmd, ...argv] of checks) {
    if (cmd === undefined) continue;
    const r = await run(cmd, argv, where);
    if (r.code !== 0) return `${[cmd, ...argv].join(" ")} failed:\n${tail(r)}`;
  }
  return undefined;
}

/**
 * The environment the install and the checks run under: no `DORI_*`, `HERDR_*` or `HC_*` variable of the detached
 * self-update process reaches them, and `DORI_HOME` points inside the throwaway worktree. A test suite that reads
 * the environment therefore cannot touch the live home or the panes it was started from.
 */
function checkEnv(
  dir: string,
  from: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && !/^(DORI|HERDR|HC)_/.test(k)) env[k] = v;
  env["DORI_HOME"] = join(dir, ".self-update-home");
  return env;
}

/** A verification worktree is named after the process that made it: `dori-self-update-<sha>-<pid>-<uuid>`. */
const WORKTREE = /dori-self-update-[0-9a-f]+-(\d+)-[0-9a-f-]+$/;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Worktrees left behind by a run that was killed before its `finally`. Only those whose process is gone are removed:
 * the lock is per DORI_HOME, so another home's run on the same checkout may be checking in one right now.
 */
async function pruneWorktrees(run: Runner): Promise<void> {
  await run("git", ["worktree", "prune"]);
  const listed = await run("git", ["worktree", "list", "--porcelain"]);
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    const pid = WORKTREE.exec(path)?.[1];
    if (pid !== undefined && !alive(Number(pid))) await run("git", ["worktree", "remove", "--force", path]);
  }
}

/**
 * Installs and runs the checks against `target` in a worktree outside the live checkout, so the running dori keeps
 * its proven code until the checks are green. The worktree is removed whatever happens. Returns why it failed.
 */
export async function verify(io: SelfUpdateIo, target: string, opts: SelfUpdateOpts): Promise<string | undefined> {
  await pruneWorktrees(io.run);
  const dir = join(tmpdir(), `dori-self-update-${short(target)}-${process.pid}-${randomUUID()}`);
  const added = await io.run("git", ["worktree", "add", "--detach", "--quiet", dir, target]);
  if (added.code !== 0) return `git worktree add for the checks failed: ${tail(added, 3)}`;
  const where = { cwd: dir, env: checkEnv(dir) };
  try {
    const [cmd, ...argv] = opts.install ?? DEFAULT_INSTALL;
    if (cmd !== undefined) {
      const i = await io.run(cmd, argv, where);
      if (i.code !== 0) return `${[cmd, ...argv].join(" ")} in the verification worktree failed:\n${tail(i)}`;
    }
    return await runChecks(io.run, opts.checks, where);
  } finally {
    await io.run("git", ["worktree", "remove", "--force", dir]);
  }
}
