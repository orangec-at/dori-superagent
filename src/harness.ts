import { existsSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "./delivery.ts";
import { memFreePct } from "./host.ts";
import { type Exec, spawnExec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { type RuntimeChoice, readRuntimeChoice } from "./runtime/select.ts";
import { Store } from "./store.ts";
import { type HostLoad, KEY_RE, type Role, reservedKey } from "./store-types.ts";
import { Telemetry, type Usage } from "./telemetry.ts";

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
export const CLI = resolve(import.meta.dir, "cli.ts");
/** The checkout this dori runs from: `dori self-update` fast-forwards it. */
export const REPO = resolve(import.meta.dir, "..");

export type Deps = {
  readonly store: Store;
  /** The session runtimes: `default` opens new sessions, `for(ref)` reaches a stored one on its own runtime. */
  readonly runtimes: Runtimes;
  /** Which runtime new sessions open on, and why (`dori status` prints it). Throws when none can be chosen. */
  readonly choice: () => RuntimeChoice;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

/** The runtime is chosen on first use, so commands that open or reach no session work without one installed. */
export const defaultDeps = (): Deps => {
  const store = new Store();
  let chosen: RuntimeChoice | undefined;
  let runtimes: Runtimes | undefined;
  const choice = (): RuntimeChoice =>
    (chosen ??= readRuntimeChoice({ env: process.env, configPath: join(store.root, "config.json") }));
  return {
    store,
    get runtimes() {
      // The choice is made only when a NEW session is opened: a stored session's own runtime needs none.
      runtimes ??= new Runtimes(
        () => choice().kind,
        (k) => (k === "hc" ? new HcRuntime(spawnExec) : new HerdrRuntime(spawnExec, process.env["DORI_HERDR_SESSION"])),
      );
      return runtimes;
    },
    choice,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

/** `DORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

/** A machine's own additions to a prompt live outside the checkout, so the checkout stays clean for self-update. */
export const overlayPath = (home: string, name: string): string => join(home, "prompts", "overlay", name);

/** The repo prompt with `$DORI_HOME/prompts/overlay/<name>` appended when that file has text. */
export function promptText(name: string, home: string | undefined): string {
  const base = readFileSync(join(promptsDir(), name), "utf8");
  const path = home === undefined ? undefined : overlayPath(home, name);
  return joinOverlay(base, path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : "");
}

/**
 * `extra` appended to `base` as written; an overlay that does not open with a blank line gets one, so it never runs
 * into the repo prompt's last line. `dori self-update --migrate-prompts` checks that this reproduces the edited file
 * byte for byte before it moves anything.
 */
export function joinOverlay(base: string, extra: string): string {
  if (!extra.trim()) return base;
  const head = base.endsWith("\n") ? base : `${base}\n`;
  const body = extra.endsWith("\n") ? extra : `${extra}\n`;
  return /^[ \t]*\n/.test(body) ? head + body : `${head}\n${body}`;
}

export const prompt = (name: string, vars: Record<string, string>, home?: string): string =>
  promptText(name, home).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** The roles `dori role` registers by hand; `dori up` also registers the two loop sessions. */
export const ROLES: readonly Role[] = ["lead", "duty"];
