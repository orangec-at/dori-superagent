// Restarting a loop pane after a self-update: SIGTERM, wait for the pass to end, SIGKILL a hung one, start it again.
import { LOOP_COMMANDS } from "./cli-up.ts";
import { shq } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { refText } from "./refs.ts";

export type Procs = {
  /** SIGTERM unless `signal` says otherwise (SIGKILL once a pass outlasts RESTART_WAIT_MS). */
  readonly kill: (pid: number, signal?: "SIGTERM" | "SIGKILL") => void;
  readonly alive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
};

export const realProcs: Procs = {
  kill: (pid, signal = "SIGTERM") => process.kill(pid, signal),
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
 * How long a loop may take to finish the pass it is in after SIGTERM. The loops only stop between passes (see
 * loop-term.ts), and an hourly pass that opens lanes can take minutes, so the restart waits for the pass rather than
 * giving up early and leaving the pane with no loop at all.
 */
export const RESTART_WAIT_MS = 15 * 60_000;
/** How long a loop gets to vanish after the SIGKILL that follows RESTART_WAIT_MS. */
export const KILL_WAIT_MS = 10_000;
const POLL_MS = 1000;

async function waitGone(pids: readonly number[], procs: Procs, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms && pids.some(procs.alive); waited += POLL_MS) await procs.sleep(POLL_MS);
  return !pids.some(procs.alive);
}

/**
 * Stops the `dori duty` / `dori loop` process in front of the role's pane (SIGTERM, then waits for its pass to end)
 * and types the same command `dori up` started into the shell it leaves behind. A pane with something else in front
 * is left alone. A pass still running after RESTART_WAIT_MS is hung, not slow: it gets SIGKILL, the loop is started
 * again, and the returned note says so (that pass may have stopped half-way).
 */
export async function restartRole(
  d: Deps,
  role: keyof typeof LOOP_COMMANDS,
  procs: Procs = realProcs,
): Promise<string | undefined> {
  const ref = d.store.roles()[role];
  if (!ref) throw new Error("not registered (dori up opens it)");
  const sub = role === "duty-loop" ? "duty" : "loop";
  const fallback = LOOP_COMMANDS[role](d.doriCmd);
  // The pids a probe reports belong to that machine; process.kill here would signal whatever local process has them.
  if (ref.machine !== undefined)
    throw new Error(`${refText(ref)} is on machine ${ref.machine}; restart dori ${sub} there by hand with ${fallback}`);
  const rt = d.runtimes.for(ref);
  const probe = await rt.probe(ref);
  // An unreadable process list reads as "shell in front"; typing then would queue a second loop behind the old one.
  if (!probe.foreground?.length)
    throw new Error(`cannot read the processes of ${refText(ref)}; restart dori ${sub} by hand with ${fallback}`);
  const loops = probe.foreground.filter((p) => p.argv.some((a) => a.endsWith("cli.ts")) && p.argv.includes(sub));
  const pids = loops.flatMap((p) => (p.pid === undefined ? [] : [p.pid]));
  if (pids.length === 0 && !probe.shellInFront)
    throw new Error(`no dori ${sub} process in front of ${refText(ref)}; restart it by hand with ${fallback}`);
  const command = loops[0] === undefined ? fallback : (restartCommand(d.doriCmd, loops[0].argv) ?? fallback);
  for (const pid of pids) procs.kill(pid);
  if (await waitGone(pids, procs, RESTART_WAIT_MS)) {
    await rt.start(ref, command);
    return undefined;
  }
  const hung = pids.filter(procs.alive);
  for (const pid of hung) procs.kill(pid, "SIGKILL");
  if (!(await waitGone(hung, procs, KILL_WAIT_MS)))
    throw new Error(
      `dori ${sub} in ${refText(ref)} survived SIGTERM, ${RESTART_WAIT_MS / 60_000} min, and SIGKILL; start it again by hand with ${command}`,
    );
  await rt.start(ref, command);
  return `dori ${sub} in ${refText(ref)} got SIGKILL: its pass was still running ${RESTART_WAIT_MS / 60_000} min after SIGTERM and may have stopped half-way`;
}

const word = (s: string): string => (/^[\w./:=@%+-]+$/.test(s) ? s : shq(s));

/**
 * The stopped loop's own subcommand and flags behind the current `dori` command, so a loop started by hand with
 * `--max-lanes`, `--interval` or `--max-load` comes back with them. `--force` is dropped: it would run a pass at once.
 */
export function restartCommand(dori: string, argv: readonly string[]): string | undefined {
  const at = argv.findIndex((a) => a.endsWith("cli.ts"));
  if (at < 0) return undefined;
  const args = argv.slice(at + 1).filter((a) => a !== "--force");
  return [dori, ...args.map(word)].join(" ");
}
