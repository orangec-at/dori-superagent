// The hourly loop's 연결 map refresh: collects board-links.json each run, bounded so a hung machine never holds it up.
import { collectLinks } from "./board-links.ts";
import { saveLinks } from "./board-links-file.ts";
import type { Deps } from "./harness.ts";

/** The hourly loop's bound on one whole collection: every machine, local and over ssh. */
export const LINKS_TIMEOUT_MS = 60_000;

/**
 * Collects the map and saves it, for the hourly loop. Past `timeoutMs` it kills the sh/ssh processes still running and
 * keeps the last saved map, so a hung machine never holds the loop up. Returns a `links: ...` line on failure, else null.
 */
export async function refreshLinks(d: Deps, timeoutMs = LINKS_TIMEOUT_MS): Promise<string | null> {
  const procs = new Set<{ kill(): void }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    const s = await Promise.race([
      collectLinks(d.exec, d.store, { now: d.now(), agentCmd: d.agentCmd, onSpawn: (p) => procs.add(p) }),
      late,
    ]);
    if (s === "late") {
      for (const p of procs) p.kill();
      return `links: 연결도 갱신 시간 초과 (${Math.ceil(timeoutMs / 1000)}초), 지난 연결도를 그대로 둠`;
    }
    saveLinks(d.store.root, s);
    return null;
  } catch (e) {
    return `links: 연결도 갱신 실패 ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160)}`;
  } finally {
    clearTimeout(timer);
  }
}
