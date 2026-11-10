import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { one, type Args } from "./cli-args.ts";
import { overlayPath, type Deps } from "./harness.ts";
import { acquire, release } from "./loop-lock.ts";
import { Refusal } from "./refusal.ts";
import { checkUpdate, selfUpdate, statusLine, type Runner } from "./self-update.ts";
import {
  lastSituation,
  loadSelfUpdateConfig,
  rememberSituation,
  repoRunner,
  restartTargets,
  selfUpdateIo,
  situation,
} from "./self-update-run.ts";

/**
 * Moves each locally edited `prompts/*.md` that only adds lines into `$DORI_HOME/prompts/overlay/<name>` (the added
 * lines, appended after the repo prompt) and restores the repo file, so the checkout is clean again. The full local
 * diff is kept next to the overlay as `<name>.local.patch`. A file that removes lines is left for a person to move.
 */
export async function migratePrompts(run: Runner, home: string): Promise<string[]> {
  const out: string[] = [];
  const names = await run("git", ["diff", "--name-only", "HEAD", "--", "prompts/"]);
  for (const file of names.stdout.split("\n").filter(Boolean)) {
    const patch = (await run("git", ["diff", "-U0", "HEAD", "--", file])).stdout;
    const lines = patch.split("\n");
    const target = overlayPath(home, basename(file));
    if (lines.some((l) => l.startsWith("-") && !l.startsWith("---"))) {
      out.push(`SKIP ${file}: the local change removes lines; move it into ${target} by hand`);
      continue;
    }
    if (existsSync(target) && readFileSync(target, "utf8").trim()) {
      out.push(`SKIP ${file}: ${target} already exists; merge the local change into it by hand`);
      continue;
    }
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.local.patch`, patch);
    writeFileSync(target, `${added.join("\n")}\n`);
    const restored = await run("git", ["checkout", "HEAD", "--", file]);
    if (restored.code !== 0) throw new Error(`git checkout HEAD -- ${file} failed: ${restored.stderr.trim()}`);
    out.push(`MIGRATED ${file} -> ${target} (${added.length} lines appended after the repo prompt)`);
  }
  return out.length ? out : ["NOTHING_TO_MIGRATE prompts/ has no local changes"];
}

/** `dori self-update [--check] [--now] [--migrate-prompts]`. Exit 0 when current or updated, 1 otherwise. */
export async function runSelfUpdate(d: Deps, a: Args, run: Runner = repoRunner(d)): Promise<number> {
  if (one(a, "migrate-prompts")) {
    for (const line of await migratePrompts(run, d.store.root)) console.log(line);
    return 0;
  }
  if (one(a, "check")) {
    const s = await checkUpdate(run);
    console.log(statusLine(s));
    return s.state === "current" ? 0 : 1;
  }
  const now = one(a, "now") === "true";
  const config = loadSelfUpdateConfig(d.store.root);
  if (!now && !config.auto) {
    console.log("SELF_UPDATE_OFF selfUpdate.auto is false or DORI_SELF_UPDATE=off; --now runs it anyway");
    return 0;
  }
  const lockPath = `${d.store.root}/self-update.lock`;
  const lock = acquire(d, lockPath);
  if ("holder" in lock) throw new Refusal(`another self-update runs in this home (${lock.holder})`);
  try {
    const before = await checkUpdate(run);
    if (!now && before.state !== "current" && lastSituation(d) === situation(before)) {
      console.log(`SELF_UPDATE_SKIPPED ${statusLine(before)} (already told; --now retries)`);
      return 1;
    }
    const io = selfUpdateIo(d, config, run);
    const r = await selfUpdate(io, { checks: config.checks, restarts: restartTargets(config) });
    rememberSituation(d, r.outcome === "updated" || r.outcome === "current" ? undefined : situation(before));
    if (r.outcome === "current") console.log(r.line);
    return r.outcome === "current" || r.outcome === "updated" ? 0 : 1;
  } finally {
    release(d, lock.nonce, lockPath);
  }
}
