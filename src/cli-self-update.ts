import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { one, type Args } from "./cli-args.ts";
import { joinOverlay, overlayPath, type Deps } from "./harness.ts";
import { acquire, release } from "./loop-lock.ts";
import { Refusal } from "./refusal.ts";
import { checkUpdate, DEFAULT_CHECKS, selfUpdate, statusLine, type Runner } from "./self-update.ts";
import {
  forgetFailures,
  isQuiet,
  isQuietKey,
  MAX_SELF_UPDATE_FAILURES,
  loadSelfUpdateConfig,
  rememberFailure,
  repoRunner,
  restartTargets,
  type SelfUpdateConfig,
  selfUpdateIo,
  situation,
} from "./self-update-run.ts";

const countLines = (text: string): number => {
  const pieces = text.split("\n");
  return pieces.at(-1) === "" ? pieces.length - 1 : pieces.length;
};

/** `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@`; a missing count means 1. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

type Hunk = { readonly oldStart: number; readonly oldCount: number; readonly added: string[]; removed: number };

/**
 * The hunks of a `-U0` diff. Lines are classified by position, after the first `@@`: a `-`/`+` prefix inside a hunk
 * is always a removed or added line, so a removed `---` rule or an added `++foo` is never mistaken for a file header.
 */
function hunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const m = HUNK.exec(line);
    if (m) {
      current = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), added: [], removed: 0 };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed += 1;
  }
  return out;
}

/**
 * Moves a locally edited `prompts/*.md` into `$DORI_HOME/prompts/overlay/<name>` and restores the repo file, so the
 * checkout is clean again. Only a change that appends at the end of the file is moved, because the overlay is
 * appended after the repo prompt: a mid-file insertion or any removal would come back somewhere else, so it is left
 * for a person. The full local diff is kept next to the overlay as `<name>.local.patch`.
 */
export async function migratePrompts(run: Runner, home: string): Promise<string[]> {
  const out: string[] = [];
  const names = await run("git", ["diff", "--name-only", "HEAD", "--", "prompts/"]);
  for (const file of names.stdout.split("\n").filter(Boolean)) {
    const target = overlayPath(home, basename(file));
    if (dirname(file) !== "prompts") {
      out.push(`SKIP ${file}: only top-level prompts/*.md have overlays; move it by hand`);
      continue;
    }
    const patch = (await run("git", ["diff", "-U0", "HEAD", "--", file])).stdout;
    const committed = await run("git", ["show", `HEAD:${file}`]);
    if (committed.code !== 0) {
      out.push(`SKIP ${file}: not committed in HEAD; move it into ${target} by hand`);
      continue;
    }
    const parsed = hunks(patch);
    const [only] = parsed;
    const appendOnly =
      parsed.length === 1 &&
      only !== undefined &&
      only.removed === 0 &&
      only.oldCount === 0 &&
      only.oldStart === countLines(committed.stdout);
    if (!appendOnly) {
      out.push(`SKIP ${file}: the local change is not a plain addition at the end; move it into ${target} by hand`);
      continue;
    }
    if (existsSync(target) && readFileSync(target, "utf8").trim()) {
      out.push(`SKIP ${file}: ${target} already exists; merge the local change into it by hand`);
      continue;
    }
    const overlay = `${only.added.join("\n")}\n`;
    const edited = await run("cat", [file]);
    if (edited.code !== 0 || joinOverlay(committed.stdout, overlay) !== edited.stdout) {
      out.push(
        `SKIP ${file}: as an overlay the local change would not render byte for byte (an overlay without a blank first line gets one); move it into ${target} by hand`,
      );
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.local.patch`, patch);
    writeFileSync(target, overlay);
    const restored = await run("git", ["checkout", "HEAD", "--", file]);
    if (restored.code !== 0) throw new Error(`git checkout HEAD -- ${file} failed: ${restored.stderr.trim()}`);
    out.push(`MIGRATED ${file} -> ${target} (${only.added.length} lines appended after the repo prompt)`);
  }
  return out.length ? out : ["NOTHING_TO_MIGRATE prompts/ has no local changes"];
}

const QUIET: SelfUpdateConfig = { auto: false, services: [], checks: DEFAULT_CHECKS };

/** `dori self-update [--check] [--now] [--migrate-prompts]`. Exit 0 when current or updated, 1 otherwise. */
export async function runSelfUpdate(d: Deps, a: Args, run: Runner = repoRunner(d)): Promise<number> {
  if (one(a, "check")) {
    const s = await checkUpdate(run);
    console.log(statusLine(s));
    return s.state === "current" ? 0 : 1;
  }
  // --migrate-prompts rewrites the same checkout an update fast-forwards, so both take the one lock.
  const lockPath = `${d.store.root}/self-update.lock`;
  const lock = acquire(d, lockPath);
  if ("holder" in lock) throw new Refusal(`another self-update runs in this home (${lock.holder})`);
  try {
    if (one(a, "migrate-prompts")) {
      for (const line of await migratePrompts(run, d.store.root)) console.log(line);
      return 0;
    }
    return await update(d, one(a, "now") === "true", run);
  } finally {
    release(d, lock.nonce, lockPath);
  }
}

async function update(d: Deps, now: boolean, run: Runner): Promise<number> {
  let config: SelfUpdateConfig;
  try {
    config = loadSelfUpdateConfig(d.store.root);
  } catch (e) {
    // A bad config would otherwise only reach self-update.log: this run is detached and nobody reads that.
    return tellError(d, now, selfUpdateIo(d, QUIET, run).tell, e);
  }
  if (!now && !config.auto) {
    console.log("SELF_UPDATE_OFF selfUpdate.auto is false or DORI_SELF_UPDATE=off; --now runs it anyway");
    return 0;
  }
  const io = selfUpdateIo(d, config, run);
  try {
    const before = await checkUpdate(run);
    if (!now && before.state !== "current" && isQuiet(d, before)) {
      console.log(`SELF_UPDATE_SKIPPED ${statusLine(before)} (tried and told already; --now retries)`);
      return 1;
    }
    const r = await selfUpdate(io, {
      checks: config.checks,
      restarts: restartTargets(config),
      ...(config.install === undefined ? {} : { install: config.install }),
    });
    const good = r.outcome === "updated" || r.outcome === "current";
    if (good) forgetFailures(d);
    else rememberFailure(d, situation(r.status));
    if (r.outcome === "current") console.log(r.line);
    return good ? 0 : 1;
  } catch (e) {
    return tellError(d, now, io.tell, e);
  }
}

/**
 * A run that threw counts toward the same quiet limit as a failed outcome, keyed by its message: an origin outage or
 * a broken config is told MAX_SELF_UPDATE_FAILURES times, not on every hourly pass. `--now` always tells.
 */
async function tellError(d: Deps, now: boolean, tell: (text: string) => Promise<void>, e: unknown): Promise<number> {
  const message = e instanceof Error ? e.message : String(e);
  const line = `[SELF-UPDATE] error: ${message}`;
  const key = `error:${message}`;
  if (!now && isQuietKey(d, key)) {
    console.log(`SELF_UPDATE_SKIPPED ${line} (told ${MAX_SELF_UPDATE_FAILURES} times already; --now retries)`);
    return 1;
  }
  rememberFailure(d, key);
  await tell(line).catch(() => {
    process.stderr.write(`${line}\n`);
  });
  return 1;
}
