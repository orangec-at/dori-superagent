// Checking off the roadmap line of a delegation that finished. A process that exited 0 is not enough: the task's text
// must name its output, and every path in it must be a file on this machine changed after the task was handed out.
// Anything else (no path, another machine's file, a stale file) stays with the lead, as before. See docs/autopilot.md.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Assignment, recordAssignment } from "./autopilot-store.ts";
import type { Deps } from "./harness.ts";
import { checkOffTask, type Roadmap } from "./roadmap.ts";

/** An absolute or `~/` path, not part of a URL, a relative path or `host:path`; ends before Korean text ("…md에 써줘"). */
const PATH = /(?<![\w:@./~-])(?:~\/|\/)[\w.~/-]*\w/g;

const expand = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Every path the task names, when there is one and all are files here modified at or after `since`. */
function freshOutputs(text: string, since: number): string[] | undefined {
  const paths = [...text.matchAll(PATH)].map((m) => m[0]);
  const fresh = (p: string): boolean => {
    try {
      const s = statSync(expand(p));
      return s.isFile() && s.mtimeMs >= since;
    } catch {
      return false;
    }
  };
  return paths.length > 0 && paths.every(fresh) ? paths : undefined;
}

/**
 * For a delegation whose run ended ok: checks off its roadmap line when its outputs are fresh, then records it
 * `completed` (still held, so it is never handed out again). Returns the lead's line, or undefined when nothing was
 * checked off now. A line checked already (by a person, or by a pass stopped before it recorded) is only recorded.
 */
export function checkOff(d: Deps, a: Assignment, roadmaps: readonly Roadmap[]): string | undefined {
  const r = roadmaps.find((x) => x.project === a.project);
  const outputs = r === undefined ? undefined : freshOutputs(a.text, a.at);
  if (r === undefined || outputs === undefined) return undefined;
  let result: ReturnType<typeof checkOffTask>;
  try {
    result = checkOffTask(r.file, r.project, a.task);
  } catch (e) {
    return `[AUTOPILOT 완료 실패] ${a.bot} ${a.project}: ${a.text} (${e instanceof Error ? e.message : String(e)})`;
  }
  if (result === "conflict") return undefined;
  recordAssignment(d.store.root, { ...a, at: d.now(), kind: "completed" });
  return result === "checked"
    ? `[AUTOPILOT 완료] ${a.bot} ${a.project}: ${a.text} -> [x] (${outputs.join(", ")})`
    : undefined;
}
