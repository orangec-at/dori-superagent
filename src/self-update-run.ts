import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOOP_COMMANDS } from "./cli-up.ts";
import { CLI, REPO, type Deps } from "./harness.ts";
import { ConfigError } from "./hooks.ts";
import { tellLead } from "./inbox.ts";
import { refText } from "./refs.ts";
import { reply } from "./reply.ts";
import {
  checkUpdate,
  DEFAULT_CHECKS,
  type RestartTarget,
  type Runner,
  type SelfUpdateIo,
  type UpdateStatus,
} from "./self-update.ts";

export type SelfUpdateConfig = {
  /** false = the kill switch: no self-update after `dori merge` or from the hourly loop (`--now` still runs). */
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
  if (raw === undefined) return { auto: !off, services: [], checks: DEFAULT_CHECKS };
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
    auto: auto !== false && !off,
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

export type Procs = {
  readonly kill: (pid: number) => void;
  readonly alive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
};

const realProcs: Procs = {
  kill: (pid) => process.kill(pid, "SIGTERM"),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  sleep: (ms) => Bun.sleep(ms),
};

/**
 * Stops the `dori duty` / `dori loop` process in front of the role's pane (SIGTERM, up to 10 s) and types the same
 * command `dori up` started into the shell it leaves behind. A pane with something else in front is left alone.
 */
export async function restartRole(d: Deps, role: keyof typeof LOOP_COMMANDS, procs: Procs = realProcs): Promise<void> {
  const ref = d.store.roles()[role];
  if (!ref) throw new Error("not registered (dori up opens it)");
  const rt = d.runtimes.for(ref);
  const probe = await rt.probe(ref);
  const sub = role === "duty-loop" ? "duty" : "loop";
  const pids = (probe.foreground ?? [])
    .filter((p) => p.argv.some((a) => a.endsWith("cli.ts")) && p.argv.includes(sub))
    .flatMap((p) => (p.pid === undefined ? [] : [p.pid]));
  if (pids.length === 0 && !probe.shellInFront)
    throw new Error(`no dori ${sub} process in front of ${refText(ref)}; restart it by hand`);
  for (const pid of pids) procs.kill(pid);
  for (let i = 0; i < 50 && pids.some(procs.alive); i++) await procs.sleep(200);
  if (pids.some(procs.alive)) throw new Error(`dori ${sub} in ${refText(ref)} did not stop after SIGTERM`);
  await rt.start(ref, LOOP_COMMANDS[role](d.doriCmd));
}

export const repoRunner =
  (d: Deps, repo: string = REPO): Runner =>
  (cmd, argv, cwd) =>
    d.exec(cmd, argv, { cwd: cwd ?? repo });

export function selfUpdateIo(d: Deps, c: SelfUpdateConfig, run: Runner = repoRunner(d)): SelfUpdateIo {
  return {
    run,
    restart: async (t) => {
      if (t.kind === "role") return restartRole(d, t.name as keyof typeof LOOP_COMMANDS);
      const r = await d.exec("systemctl", ["--user", "restart", t.name]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
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

/** Whether automatic runs should leave this situation alone: it already failed MAX_SELF_UPDATE_FAILURES times. */
export const isQuiet = (d: Deps, s: UpdateStatus): boolean => {
  const m = memo(d);
  return m.situation === situation(s) && (m.failures ?? 0) >= MAX_SELF_UPDATE_FAILURES;
};
export const rememberFailure = (d: Deps, s: string): void => {
  const m = memo(d);
  write(d, { situation: s, failures: m.situation === s ? (m.failures ?? 0) + 1 : 1 });
};
export const forgetFailures = (d: Deps): void => write(d, { failures: 0 });

/** Starts `dori self-update` in its own session, logging to `$DORI_HOME/self-update.log`: it outlives the loop it restarts. */
export function spawnSelfUpdate(d: Deps): void {
  const log = openSync(join(d.store.root, "self-update.log"), "a");
  const env = { ...process.env, DORI_HOME: d.store.root };
  spawn(process.execPath, [CLI, "self-update"], { detached: true, stdio: ["ignore", log, log], env }).unref();
}

/**
 * The automatic trigger (after `dori merge` of dori's own repo, and every hourly loop run): when auto is on and the
 * checkout is not current and not in the situation already told, start `dori self-update` in the background.
 */
export async function autoSelfUpdate(
  d: Deps,
  start: (d: Deps) => void = spawnSelfUpdate,
  run: Runner = repoRunner(d),
): Promise<string> {
  if (!loadSelfUpdateConfig(d.store.root).auto) return "SELF_UPDATE_OFF (selfUpdate.auto or DORI_SELF_UPDATE=off)";
  const s = await checkUpdate(run);
  if (s.state === "current") return `SELF_UPDATE_CURRENT ${s.head.slice(0, 7)}`;
  if (isQuiet(d, s))
    return `SELF_UPDATE_SKIPPED ${s.state} at ${s.target.slice(0, 7)} failed ${MAX_SELF_UPDATE_FAILURES} times already`;
  start(d);
  return `SELF_UPDATE_STARTED ${s.state} ${s.head.slice(0, 7)}..${s.target.slice(0, 7)} (log: ${join(d.store.root, "self-update.log")})`;
}

/** owner/repo of the checkout's origin, from an https or ssh GitHub URL. */
export async function originRepo(run: Runner): Promise<string | undefined> {
  const r = await run("git", ["remote", "get-url", "origin"]);
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout)?.[1];
}
