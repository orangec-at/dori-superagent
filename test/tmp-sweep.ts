import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const STALE_MS = 60 * 60 * 1000;

// The per-run sandbox, plus the names tests put straight into the tmpdir before the sandbox existed.
export const TEST_PREFIXES = [
  "dori-run-",
  "dori-test-",
  "dori-select-",
  "dori-selfupdate-",
  "dori-board-",
  "dori-tel-",
  "dori-home-",
  "dori-agents-",
  "dori-prompts-",
  "dori-e2e-",
  "dori-group-",
  "dori-none-",
] as const;

/**
 * Removes the test-run leftovers in `base`: directories whose name starts with a test prefix, owned by `uid`, and not
 * modified for STALE_MS. Anything else in the tmpdir, another user's or another program's, is left alone.
 */
export const sweepStale = (base: string, uid: number | undefined, now = Date.now()): string[] => {
  if (uid === undefined) return [];
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    if (!TEST_PREFIXES.some((p) => name.startsWith(p))) continue;
    const path = join(base, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs < STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Gone already (another run swept it first) or unreadable: either way not ours to report.
    }
  }
  return removed;
};
