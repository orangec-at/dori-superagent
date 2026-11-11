import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LOOP_COMMANDS } from "./cli-up.ts";
import { CLI, REPO, type Deps } from "./harness.ts";
import { ConfigError } from "./hooks.ts";
import { tellLead } from "./inbox.ts";
import { reply } from "./reply.ts";
import { restartRole } from "./self-update-restart.ts";
import {
  DEFAULT_CHECKS,
  type RestartTarget,
  type Runner,
  type SelfUpdateIo,
  type UpdateStatus,
} from "./self-update.ts";

export type SelfUpdateConfig = {
  /**
   * Opt-in: only `true` lets `dori merge` and the hourly loop start a self-update. Default (absent) is off, and
   * `DORI_SELF_UPDATE=off` forces it off. A `dori self-update` run by hand is never stopped by it.
   */
  readonly auto: boolean;
  /** A `dori reply` address (discord:<channel>, slack:..., hermes:...) that gets every `[SELF-UPDATE]` line. */
  readonly notify?: string;
  /** User systemd services restarted after a good update, e.g. ["dori-serve"]. */
  readonly services: readonly string[];
  readonly checks: readonly (readonly string[])[];
  /** How dependencies are installed; defaults to `bun install --frozen-lockfile`. */
  readonly install?: readonly string[];
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** `selfUpdate` in `$DORI_HOME/config.json`; `DORI_SELF_UPDATE=off` in the environment also turns auto off. */
export function loadSelfUpdateConfig(root: string): SelfUpdateConfig {
  const path = join(root, "config.json");
  const raw: unknown = existsSync(path)
    ? Reflect.get(JSON.parse(readFileSync(path, "utf8")) as object, "selfUpdate")
    : undefined;
  const off = process.env["DORI_SELF_UPDATE"] === "off";
  if (raw === undefined) return { auto: false, services: [], checks: DEFAULT_CHECKS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("config.json: selfUpdate must be an object");
  const auto: unknown = Reflect.get(raw, "auto");
  const notify: unknown = Reflect.get(raw, "notify");
  const services: unknown = Reflect.get(raw, "services");
  const checks: unknown = Reflect.get(raw, "checks");
  const install: unknown = Reflect.get(raw, "install");
  if (auto !== undefined && typeof auto !== "boolean")
    throw new ConfigError("config.json: selfUpdate.auto must be true or false");
  if (notify !== undefined && typeof notify !== "string")
    throw new ConfigError("config.json: selfUpdate.notify must be a reply address");
  if (services !== undefined && !strings(services))
    throw new ConfigError("config.json: selfUpdate.services must be an array of strings");
  if (checks !== undefined && !(Array.isArray(checks) && checks.every((c) => strings(c) && c.length > 0)))
    throw new ConfigError("config.json: selfUpdate.checks must be an array of argv arrays");
  if (install !== undefined && !(strings(install) && install.length > 0))
    throw new ConfigError("config.json: selfUpdate.install must be a non-empty array of strings (an argv)");
  return {
    auto: auto === true && !off,
    ...(notify === undefined ? {} : { notify }),
    ...(install === undefined ? {} : { install }),
    services: services ?? [],
    checks: (checks as string[][] | undefined) ?? DEFAULT_CHECKS,
  };
}

/** Services first, then the duty loop, then the hourly loop: the two panes `dori up` opened. Lanes and the lead are never touched. */
export const restartTargets = (c: SelfUpdateConfig): RestartTarget[] => [
  ...c.services.map((name) => ({ kind: "service" as const, name })),
  { kind: "role", name: "duty-loop" },
  { kind: "role", name: "hourly-loop" },
];

export const repoRunner =
  (d: Deps, repo: string = REPO): Runner =>
  (cmd, argv, where) =>
    d.exec(cmd, argv, { cwd: where?.cwd ?? repo, ...(where?.env === undefined ? {} : { env: where.env }) });

export function selfUpdateIo(d: Deps, c: SelfUpdateConfig, run: Runner = repoRunner(d)): SelfUpdateIo {
  return {
    run,
    restart: async (t) => {
      if (t.kind === "role") return restartRole(d, t.name as keyof typeof LOOP_COMMANDS);
      const r = await d.exec("systemctl", ["--user", "restart", t.name]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
      return undefined;
    },
    tell: async (text) => {
      console.log(text);
      const fail = (to: string, e: unknown) =>
        process.stderr.write(`dori: self-update could not tell ${to}: ${e instanceof Error ? e.message : String(e)}\n`);
      await tellLead(d, text, "self-update").catch((e: unknown) => fail("the lead", e));
      if (c.notify)
        await reply(d.exec, c.notify, text, { home: d.store.root }).catch((e: unknown) => fail(c.notify!, e));
    },
  };
}

/**
 * How many times the same situation (head, target, state) may fail before automatic runs go quiet about it. One
 * flaky check run must not stop the host from updating until the next commit lands; a genuinely broken commit is
 * told twice, not every hour. `--now` always retries.
 */
export const MAX_SELF_UPDATE_FAILURES = 2;

type Memo = { readonly situation?: string; readonly failures?: number };
const memoPath = (d: Deps) => join(d.store.root, "self-update.json");
const memo = (d: Deps): Memo =>
  existsSync(memoPath(d)) ? (JSON.parse(readFileSync(memoPath(d), "utf8")) as Memo) : {};
const write = (d: Deps, m: Memo): void => writeFileSync(memoPath(d), `${JSON.stringify({ ...m, at: d.now() })}\n`);

export const situation = (s: UpdateStatus): string => `${s.head}:${s.target}:${s.state}`;

/** Whether `key` (a situation, or `error:<message>` for a run that threw) already failed MAX_SELF_UPDATE_FAILURES times. */
export const isQuietKey = (d: Deps, key: string): boolean => {
  const m = memo(d);
  return m.situation === key && (m.failures ?? 0) >= MAX_SELF_UPDATE_FAILURES;
};
export const isQuiet = (d: Deps, s: UpdateStatus): boolean => isQuietKey(d, situation(s));
export const rememberFailure = (d: Deps, s: string): void => {
  const m = memo(d);
  write(d, { situation: s, failures: m.situation === s ? (m.failures ?? 0) + 1 : 1 });
};
export const forgetFailures = (d: Deps): void => write(d, { failures: 0 });

/** Starts `dori self-update` in its own session, logging to `$DORI_HOME/self-update.log`: it outlives the loop it restarts. */
export function spawnSelfUpdate(d: Deps): void {
  const log = openSync(join(d.store.root, "self-update.log"), "a");
  const env = { ...process.env, DORI_HOME: d.store.root };
  spawn(process.execPath, [CLI, "self-update", "--auto"], { detached: true, stdio: ["ignore", log, log], env }).unref();
}

/**
 * The automatic trigger (after `dori merge` of dori's own repo, and after every hourly pass that ran): unless auto is
 * off or the loop is stopped, start `dori self-update` in the background. It does no network call itself: the fetch,
 * the "already failed twice" check and the lock all live in that detached process, so a stalled fetch can never hang
 * the hourly loop.
 */
export function autoSelfUpdate(d: Deps, start: (d: Deps) => void = spawnSelfUpdate): string {
  if (!loadSelfUpdateConfig(d.store.root).auto)
    return 'SELF_UPDATE_OFF automatic runs are opt-in: set "selfUpdate": { "auto": true } in config.json';
  const stop = d.store.stop();
  if (stop) return `SELF_UPDATE_OFF the loop is stopped (${stop.reason}); dori loop resume turns it back on`;
  start(d);
  return `SELF_UPDATE_STARTED (log: ${join(d.store.root, "self-update.log")})`;
}

/**
 * After `dori merge` succeeded: a PR of the checkout's own origin repository (compared without case) starts the
 * trigger. The merge already happened, so this never throws: a failure comes back as a `SELF_UPDATE_ERROR` line.
 */
export async function afterMerge(
  d: Deps,
  prRepo: string,
  run: Runner = repoRunner(d),
  start: (d: Deps) => void = spawnSelfUpdate,
): Promise<string | undefined> {
  try {
    const origin = await originRepo(run);
    if (origin === undefined || prRepo.toLowerCase() !== origin.toLowerCase()) return undefined;
    return autoSelfUpdate(d, start);
  } catch (e) {
    return `SELF_UPDATE_ERROR ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** owner/repo of the checkout's origin, from an https or ssh GitHub URL. */
export async function originRepo(run: Runner): Promise<string | undefined> {
  const r = await run("git", ["remote", "get-url", "origin"]);
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout)?.[1];
}
