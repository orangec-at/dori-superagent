// dori self-update: prove the target commit in a throwaway worktree, and only then fast-forward the checkout dori
// runs from and restart the duty loop, the hourly loop and the configured services. The live checkout is never left
// on unproven code: install and checks run somewhere else first. Fast-forward only: never force, never reset --hard,
// never drop a local commit.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "./runtime/exec.ts";

/** Runs one command in the checkout, or in `cwd` when one is given (the verification worktree). */
export type Runner = (cmd: string, argv: readonly string[], cwd?: string) => Promise<ExecResult>;

/** What a successful update restarts: a role pane `dori up` opened, or a user systemd service. */
export type RestartTarget =
  | { readonly kind: "role"; readonly name: string }
  | { readonly kind: "service"; readonly name: string };

export type SelfUpdateIo = {
  readonly run: Runner;
  /** Resolves when restarted; throws with the reason otherwise. */
  readonly restart: (target: RestartTarget) => Promise<void>;
  /** One line to the lead and the operator. */
  readonly tell: (text: string) => Promise<void>;
};

export type SelfUpdateOpts = {
  readonly checks: readonly (readonly string[])[];
  readonly restarts: readonly RestartTarget[];
  /** How dependencies are installed, in the verification worktree and after the fast-forward. */
  readonly install?: readonly string[];
};

export const DEFAULT_CHECKS: readonly (readonly string[])[] = [
  ["bun", "run", "typecheck"],
  ["bun", "test", "./test/"],
];
export const DEFAULT_INSTALL: readonly string[] = ["bun", "install", "--frozen-lockfile"];

export type UpdateStatus =
  | { readonly state: "current"; readonly head: string; readonly target: string; readonly upstream: string }
  | {
      readonly state: "behind";
      readonly head: string;
      readonly target: string;
      readonly upstream: string;
      readonly behind: number;
    }
  | { readonly state: "diverged"; readonly head: string; readonly target: string; readonly upstream: string }
  | {
      readonly state: "dirty";
      readonly head: string;
      readonly target: string;
      readonly upstream: string;
      readonly files: readonly string[];
    };

export type UpdateOutcome =
  | { readonly outcome: "current" | "updated"; readonly line: string; readonly restartFailures: readonly string[] }
  | { readonly outcome: "refused" | "unproven" | "failed" | "rolled-back"; readonly line: string };

const short = (sha: string): string => sha.slice(0, 7);
const tail = (r: ExecResult, n = 15): string =>
  `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-n).join("\n") || `exit ${r.code}`;

async function git(run: Runner, argv: readonly string[]): Promise<string> {
  const r = await run("git", argv);
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${tail(r, 3)}`);
  return r.stdout.trim();
}

/** origin's default branch (refs/remotes/origin/HEAD), else `main`. */
async function upstreamRef(run: Runner): Promise<string> {
  const r = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "origin/main";
}

/** Fetches origin and says whether HEAD is current, behind (fast-forwardable), diverged, or blocked by local edits. */
export async function checkUpdate(run: Runner): Promise<UpdateStatus> {
  await git(run, ["fetch", "--quiet", "origin"]);
  const upstream = await upstreamRef(run);
  const head = await git(run, ["rev-parse", "HEAD"]);
  const target = await git(run, ["rev-parse", upstream]);
  const base = { head, target, upstream };
  if (head === target) return { state: "current", ...base };
  const ancestor = await run("git", ["merge-base", "--is-ancestor", head, target]);
  if (ancestor.code !== 0) return { state: "diverged", ...base };
  // Untracked files do not block a fast-forward unless they collide, and git refuses that case itself.
  const porcelain = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (porcelain.code !== 0) throw new Error(`git status failed: ${tail(porcelain, 3)}`);
  const files = porcelain.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  if (files.length > 0) return { state: "dirty", ...base, files };
  const behind = Number(await git(run, ["rev-list", "--count", `${head}..${target}`]));
  return { state: "behind", ...base, behind };
}

export function statusLine(s: UpdateStatus): string {
  switch (s.state) {
    case "current":
      return `SELF_UPDATE_CURRENT ${short(s.head)} (${s.upstream})`;
    case "behind":
      return `SELF_UPDATE_BEHIND ${short(s.head)}..${short(s.target)} (${s.behind} commit(s) behind ${s.upstream})`;
    case "diverged":
      return `SELF_UPDATE_DIVERGED ${short(s.head)} is not an ancestor of ${s.upstream} ${short(s.target)}: local commits, no fast-forward`;
    case "dirty":
      return `SELF_UPDATE_DIRTY local changes in ${s.files.join(", ")}: move machine rules to $DORI_HOME/prompts/overlay (dori self-update --migrate-prompts)`;
  }
}

/** Runs the checks in order; the first failure is returned with the tail of its output. */
async function runChecks(run: Runner, checks: SelfUpdateOpts["checks"], cwd: string): Promise<string | undefined> {
  for (const [cmd, ...argv] of checks) {
    if (cmd === undefined) continue;
    const r = await run(cmd, argv, cwd);
    if (r.code !== 0) return `${[cmd, ...argv].join(" ")} failed:\n${tail(r)}`;
  }
  return undefined;
}

/**
 * Installs and runs the checks against `target` in a worktree outside the live checkout, so the running dori keeps
 * its proven code until the checks are green. The worktree is removed whatever happens.
 */
async function verify(io: SelfUpdateIo, target: string, opts: SelfUpdateOpts): Promise<string | undefined> {
  const dir = join(tmpdir(), `dori-self-update-${short(target)}-${randomUUID()}`);
  const added = await io.run("git", ["worktree", "add", "--detach", "--quiet", dir, target]);
  if (added.code !== 0) return `git worktree add for the checks failed: ${tail(added, 3)}`;
  try {
    const [cmd, ...argv] = opts.install ?? DEFAULT_INSTALL;
    if (cmd !== undefined) {
      const i = await io.run(cmd, argv, dir);
      if (i.code !== 0) return `${[cmd, ...argv].join(" ")} in the verification worktree failed:\n${tail(i)}`;
    }
    return await runChecks(io.run, opts.checks, dir);
  } finally {
    await io.run("git", ["worktree", "remove", "--force", dir]);
  }
}

/** Back to `old`: reset --keep moves HEAD (and a checked-out branch) back and refuses to touch local edits. */
async function rollBack(io: SelfUpdateIo, old: string, opts: SelfUpdateOpts): Promise<string | undefined> {
  const r = await io.run("git", ["reset", "--keep", old]);
  if (r.code !== 0) return `git reset --keep ${short(old)} failed: ${tail(r, 3)}`;
  const [cmd, ...argv] = opts.install ?? DEFAULT_INSTALL;
  if (cmd === undefined) return undefined;
  const i = await io.run(cmd, argv);
  return i.code === 0 ? undefined : `${[cmd, ...argv].join(" ")} after the rollback failed: ${tail(i, 3)}`;
}

/**
 * The whole update. A checkout that is current changes nothing and says nothing; a dirty or diverged one is left as
 * it is and the reason is told. Every outcome but `current` is told to the lead and the operator as one
 * `[SELF-UPDATE] ...` message.
 */
export async function selfUpdate(io: SelfUpdateIo, opts: SelfUpdateOpts): Promise<UpdateOutcome> {
  const s = await checkUpdate(io.run);
  if (s.state === "current") return { outcome: "current", line: statusLine(s), restartFailures: [] };
  if (s.state !== "behind") {
    const line = `[SELF-UPDATE] refused: ${statusLine(s)}`;
    await io.tell(line);
    return { outcome: "refused", line };
  }
  const old = s.head;
  const range = `${short(old)}..${short(s.target)}`;
  const unproven = await verify(io, s.target, opts);
  if (unproven !== undefined) {
    const line = `[SELF-UPDATE] ${range} not applied: still at ${short(old)}, nothing restarted. ${unproven}`;
    await io.tell(line);
    return { outcome: "unproven", line };
  }
  const lockChanged = (await io.run("git", ["diff", "--quiet", old, s.target, "--", "bun.lock"])).code !== 0;
  const ff = await io.run("git", ["merge", "--ff-only", s.target]);
  if (ff.code !== 0) {
    const line = `[SELF-UPDATE] ${range} failed: git merge --ff-only: ${tail(ff, 3)}; still at ${short(old)}`;
    await io.tell(line);
    return { outcome: "failed", line };
  }
  if (lockChanged) {
    const [cmd, ...argv] = opts.install ?? DEFAULT_INSTALL;
    const i = cmd === undefined ? undefined : await io.run(cmd, argv);
    if (i !== undefined && i.code !== 0) {
      const back = await rollBack(io, old, opts);
      const why = `${[cmd, ...argv].join(" ")} in the checkout failed:\n${tail(i)}`;
      const line = back
        ? `[SELF-UPDATE] ${range} ROLLBACK FAILED (${back}); nothing restarted, fix the checkout by hand. ${why}`
        : `[SELF-UPDATE] ${range} rolled back to ${short(old)}; nothing restarted. ${why}`;
      await io.tell(line);
      return { outcome: "rolled-back", line };
    }
  }
  const restartFailures: string[] = [];
  for (const t of opts.restarts) {
    try {
      await io.restart(t);
    } catch (e) {
      restartFailures.push(`${t.kind} ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const line = `[SELF-UPDATE] ${range}${restartFailures.length ? ` (restart failed: ${restartFailures.join("; ")})` : ""}`;
  await io.tell(line);
  return { outcome: "updated", line, restartFailures };
}
