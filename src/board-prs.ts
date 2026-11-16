import type { Lane } from "./store-types.ts";

/** A pull request a lane mentions: from a GitHub URL (repo and link known) or a bare `PR #N` (number only). */
export type Pr = { repo: string | null; num: number; url: string | null };

const URL_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const BARE_RE = /\bPR\s*#(\d+)/gi;

/** Every PR a lane's log and final answer name, first mention first; a bare number a URL already names is dropped. */
export function lanePrs(lane: Pick<Lane, "log" | "final">): Pr[] {
  const texts = [...lane.log.map((e) => e.text), lane.final?.text ?? "", ...(lane.final?.evidence ?? [])];
  const found: Pr[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(URL_RE)) {
      const num = Number(m[2]);
      if (!found.some((p) => p.repo === m[1] && p.num === num)) found.push({ repo: m[1]!, num, url: m[0] });
    }
  }
  for (const t of texts) {
    for (const m of t.matchAll(BARE_RE)) {
      const num = Number(m[1]);
      if (!found.some((p) => p.num === num)) found.push({ repo: null, num, url: null });
    }
  }
  return found;
}
