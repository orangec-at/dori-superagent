// Checking off the roadmap line of a delegation that finished. A process that exited 0 is not enough: the task's text
// must name its output, and every output path in it must be a file on the bot's machine changed after the task was handed
// out (a remote bot's are read over ssh, autopilot-remote.ts). Anything else (no path, a stale file) stays with the
// lead, as before. See docs/autopilot.md.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Assignment, assignmentKey, readState, recordAssignment, writeJson } from "./autopilot-store.ts";
import type { Deps } from "./harness.ts";
import { checkOffTask, type Roadmap } from "./roadmap.ts";

/**
 * An absolute or `~/` path, not part of a URL, a relative path or `host:path`. Letters of any script count, so
 * `~/.dori/out/보고서.md` is one path. Korean right after an ASCII letter or digit is a particle, not the path
 * ("…/a.md에 써줘" names `…/a.md`); Korean right after Korean cannot be told apart and stays in ("…/보고서에").
 */
const PATH = /(?<![\p{L}\p{N}_:@./~-])(?:~\/|\/)[\p{L}\p{N}_.~/-]*[\p{L}\p{N}_]/gu;
const PARTICLE = /(?<=[A-Za-z0-9_])\p{Script=Hangul}+$/u;
/**
 * What follows an output path: an optional space and 파일, then 에 and a verb that writes ("…/a.md에 써줘", "…/a.md에
 * 저장", "…/보고서 에 써줘"), or 로/으로 and a verb that saves ("…/a.md로 저장"). Up to three words ending in 로 or 게
 * may stand before the verb ("…/a.md에 표로 써줘", "…에 한국어로 정리", "…에 짧게 정리"); any other word ends the
 * marker. A negated verb ("…/a.md에 쓰지 말고") is no marker, and neither is one that says the file already holds the
 * text ("…/a.md에 기록된 오류", "…에 정리한 내용", "…에 쓰인 규칙", "…에 정리해둔 표", "…에 쓰는 형식"): such a path is an input. A task that marks some
 * paths this way names the rest as inputs to read, which need not change; one that marks none keeps every path an
 * output (fail closed: "…/a.md에서 읽고 정리" or "…/보고서에 써줘" still needs every path fresh).
 */
const MODIFIERS = String.raw`(?:[\p{L}\p{N}]+(?:로|게)\s*){0,3}`;
const NOT_NEGATED = String.raw`(?!\p{L}*지\s*(?:말|않|마))`;
const NOT_WRITTEN = String.raw`(?!\s*(?:어|아|여|해)?\s*(?:(?:된|됨|돼|진|인|한|은|는|던|둔|하는|하신|했던)(?!\p{L})|되어|놓은|놓인|있는|있던))`;
const WRITES_TO = new RegExp(
  String.raw`^\s*(?:파일\s*)?(?:에\s*${MODIFIERS}(?:써|쓰|작성|저장|정리|기록|남기|남겨|만들|담아|추가)` +
    String.raw`|으?로\s*${MODIFIERS}(?:저장|써|쓰|작성|기록|내보내|출력|남기|남겨))${NOT_NEGATED}${NOT_WRITTEN}`,
  "u",
);

const expand = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Whether every one of `paths` is a file modified at or after `since`, on the bot's machine. */
export type FreshCheck = (paths: string[], since: number) => boolean | Promise<boolean>;

/** The FreshCheck of a bot on this machine. */
export const freshHere: FreshCheck = (paths, since) =>
  paths.every((p) => {
    try {
      const s = statSync(expand(p));
      return s.isFile() && s.mtimeMs >= since;
    } catch {
      return false;
    }
  });

/** The paths a task writes to: the marked outputs, or every path when none is marked. */
function outputPaths(text: string): string[] {
  const named = [...text.matchAll(PATH)].map((m) => {
    const path = m[0].replace(PARTICLE, "");
    return { path, output: WRITES_TO.test(text.slice(m.index + path.length)) };
  });
  return (named.some((p) => p.output) ? named.filter((p) => p.output) : named).map((p) => p.path);
}

/**
 * For a delegation whose run ended ok: checks off its roadmap line when its outputs are fresh, then records it
 * `completed` (still held, so it is never handed out again). Returns the lead's line, or undefined when nothing was
 * checked off now. A line checked already (by a person, or by a pass stopped before it recorded) is only recorded.
 * A write that fails is told once per delegation and failure (`state.json` `checkOffFailed`), and retried every pass.
 */
export async function checkOff(
  d: Deps,
  a: Assignment,
  roadmaps: readonly Roadmap[],
  fresh: FreshCheck,
): Promise<string | undefined> {
  const r = roadmaps.find((x) => x.project === a.project);
  if (r === undefined) return undefined;
  const outputs = outputPaths(a.text);
  if (outputs.length === 0 || !(await fresh(outputs, a.at))) return undefined;
  let result: ReturnType<typeof checkOffTask>;
  try {
    result = checkOffTask(r.file, r.project, a.task);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The error code, not the message: the message names the temporary file, whose pid changes with each duty run.
    const failure = (e as { code?: unknown }).code?.toString() ?? message;
    const key = failureKey(a);
    const state = readState(d.store.root);
    if (state.checkOffFailed?.[key] === failure) return undefined;
    writeJson(d.store.root, "state.json", { ...state, checkOffFailed: { ...state.checkOffFailed, [key]: failure } });
    return `[AUTOPILOT 완료 실패] ${a.bot} ${a.project}: ${a.text} (${message})`;
  }
  if (result === "conflict") return undefined;
  recordAssignment(d.store.root, { ...a, at: d.now(), kind: "completed" });
  forgetFailure(d, a);
  return result === "checked"
    ? `[AUTOPILOT 완료] ${a.bot} ${a.project}: ${a.text} -> [x] (${outputs.join(", ")})`
    : undefined;
}

const failureKey = (a: Assignment): string => `${assignmentKey(a)}@${a.at}`;

/** Drops a delegation's told failure once its line is checked off, so state.json does not keep it forever. */
function forgetFailure(d: Deps, a: Assignment): void {
  const state = readState(d.store.root);
  const key = failureKey(a);
  if (state.checkOffFailed?.[key] === undefined) return;
  const checkOffFailed = Object.fromEntries(Object.entries(state.checkOffFailed).filter(([k]) => k !== key));
  writeJson(d.store.root, "state.json", { ...state, checkOffFailed });
}
