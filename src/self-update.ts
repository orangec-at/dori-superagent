// dori self-update: fast-forward the checkout dori runs from, prove it with typecheck + tests, and only then restart
// the duty loop, the hourly loop and the configured services. Fast-forward only: never force, never reset --hard,
// never drop a local commit. A failed check goes back to the old HEAD and nothing is restarted.
import type { ExecResult } from "./runtime/exec.ts";

/** Runs one command in the checkout. */
export type Runner = (cmd: string, argv: readonly string[]) => Promise<ExecResult>;

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
};

export const DEFAULT_CHECKS: readonly (readonly string[])[] = [
  ["bun", "run", "typecheck"],
  ["bun", "test", "./test/"],
];

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
  | { readonly outcome: "refused" | "failed" | "rolled-back"; readonly line: string };

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
async function runChecks(run: Runner, checks: SelfUpdateOpts["checks"]): Promise<string | undefined> {
  for (const [cmd, ...argv] of checks) {
    if (cmd === undefined) continue;
    const r = await run(cmd, argv);
    if (r.code !== 0) return `${[cmd, ...argv].join(" ")} failed:\n${tail(r)}`;
  }
  return undefined;
}

/** Back to `old`: reset --keep moves HEAD (and a checked-out branch) back and refuses to touch local edits. */
async function rollBack(run: Runner, old: string, lockChanged: boolean): Promise<string | undefined> {
  const r = await run("git", ["reset", "--keep", old]);
  if (r.code !== 0) return `git reset --keep ${short(old)} failed: ${tail(r, 3)}`;
  if (lockChanged) {
    const i = await run("bun", ["install", "--frozen-lockfile"]);
    if (i.code !== 0) return `bun install after the rollback failed: ${tail(i, 3)}`;
  }
  return undefined;
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
  const lockChanged = (await io.run("git", ["diff", "--quiet", old, s.target, "--", "bun.lock"])).code !== 0;
  const ff = await io.run("git", ["merge", "--ff-only", s.target]);
  if (ff.code !== 0) {
    const line = `[SELF-UPDATE] ${range} failed: git merge --ff-only: ${tail(ff, 3)}; still at ${short(old)}`;
    await io.tell(line);
    return { outcome: "failed", line };
  }
  let why: string | undefined;
  if (lockChanged) {
    const i = await io.run("bun", ["install", "--frozen-lockfile"]);
    if (i.code !== 0) why = `bun install failed:\n${tail(i)}`;
  }
  why ??= await runChecks(io.run, opts.checks);
  if (why !== undefined) {
    const back = await rollBack(io.run, old, lockChanged);
    const line = back
      ? `[SELF-UPDATE] ${range} ROLLBACK FAILED (${back}); nothing restarted, fix the checkout by hand. Check failure: ${why}`
      : `[SELF-UPDATE] ${range} rolled back to ${short(old)}; nothing restarted. ${why}`;
    await io.tell(line);
    return { outcome: "rolled-back", line };
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
