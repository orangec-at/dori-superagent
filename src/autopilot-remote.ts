// Checking a remote bot's outputs: one ssh call per delegation and pass reads every output's type and mtime on the
// bot's machine. Only files under that machine's ~/.dori/out count. A failed, late or unreadable answer counts as "not
// fresh", so the line stays open exactly as for a missing local file. See docs/autopilot.md "Checking off".
import { shq } from "./delivery.ts";
import type { Exec, ExecResult } from "./runtime/exec.ts";

/** How long all remote checks of one pass may take together; past it, the rest wait for the next pass. */
export const REMOTE_CHECK_MS = 5_000;
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2"] as const;
const OUT = "~/.dori/out/";

/**
 * Runs under `sh` on the bot's machine with the paths as its arguments. One line per path, in order: `ok <mtime s>`
 * for a regular file (not a link) whose real directory lies under the real ~/.dori/out, else `no`. GNU stat takes
 * `-c %Y`, BSD (macOS) `-f %m`.
 */
const PROBE = `out=$(cd "$HOME/.dori/out" 2>/dev/null && pwd -P) || exit 3
for p do
  case $p in "~/"*) p="$HOME/\${p#"~/"}";; esac
  d=$(cd "\${p%/*}" 2>/dev/null && pwd -P) || d=
  f="$d/\${p##*/}"
  m=
  case $d/ in "$out"/*) [ -f "$f" ] && [ ! -L "$f" ] && m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) ;; esac
  case $m in ''|*[!0-9]*) echo no ;; *) echo "ok $m" ;; esac
done`;

/** The pass's shared time for remote checks. Its clock starts with the first remote check; `stop` ends it. */
export class RemoteBudget {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #expired: Promise<"expired"> | undefined;
  spent = false;
  constructor(readonly ms = REMOTE_CHECK_MS) {}
  expired(): Promise<"expired"> {
    this.#expired ??= new Promise((r) => {
      this.#timer = setTimeout(() => {
        this.spent = true;
        r("expired");
      }, this.ms);
    });
    return this.#expired;
  }
  stop(): void {
    clearTimeout(this.#timer);
  }
}

/** A path the probe may be asked about: `~/.dori/out/...` or absolute (checked on the machine), never `..`. */
const inScope = (p: string): boolean =>
  (p.startsWith(OUT) || p.startsWith("/")) && !p.split("/").some((s) => s === ".." || s === ".");

/** The ssh argv for one probe; the paths are quoted words, the task's text never reaches a shell. */
export const probeArgv = (host: string, paths: readonly string[]): string[] => [
  ...SSH_OPTIONS,
  host,
  ["sh", "-c", shq(PROBE), "sh", ...paths.map(shq)].join(" "),
];

/** True when every path is a regular file under the host's ~/.dori/out changed at or after `since` (ms). */
export async function remoteFresh(
  exec: Exec,
  host: string,
  paths: readonly string[],
  since: number,
  budget: RemoteBudget,
): Promise<boolean> {
  if (paths.length === 0 || !paths.every(inScope) || budget.spent) return false;
  let proc: { kill(): void } | undefined;
  const run = exec("ssh", probeArgv(host, paths), { onSpawn: (p) => (proc = p) }).catch(
    (): ExecResult => ({ code: -1, stdout: "", stderr: "" }),
  );
  const result = await Promise.race([run, budget.expired()]);
  if (result === "expired") {
    proc?.kill();
    return false;
  }
  if (result.code !== 0) return false;
  const lines = result.stdout.trimEnd().split("\n");
  return (
    lines.length === paths.length &&
    lines.every((l) => {
      const m = /^ok (\d+)$/.exec(l);
      return m !== null && Number(m[1]) * 1000 >= since;
    })
  );
}
