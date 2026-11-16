import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./agents.ts";

const KST_MS = 9 * 3_600_000;
export const DELEGATION_TAIL_BYTES = 256 * 1024;
const CUT = 160;

/** One bot from agents.json with what the day's assignment file and the delegation log say about it. */
export type BotCard = {
  name: string;
  label: string;
  role: string;
  today: string | null;
  result: string | null;
  lastDelegate: { at: string; outcome: string; summary: string } | null;
};

/** Some reports arrive with JSON escapes left in the text (`\\n`, `\\uc8fc`): they are shown as what they stand for. */
export const decodeEscapes = (s: string): string =>
  s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\[nrt]/g, " ");
const oneLine = (s: string): string => decodeEscapes(s).replace(/\s+/g, " ").trim();
const clip = (s: string, n = CUT): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The first non-empty line of a lane report, without the box-drawing a hermes answer is framed in. */
export const firstLine = (text: string): string =>
  clip(
    text
      .split("\n")
      .map((l) => oneLine(l.replace(/[│┃╭╮╰╯─━┌┐└┘|]/g, " ")))
      .find((l) => l !== "") ?? "",
  );

/** The bot's Korean name: the description up to its first "(" ("엔도(fedora): ..." -> 엔도), else its name. */
export const botLabel = (a: Agent): string => /^([^(:]+)\(/.exec(a.description)?.[1]?.trim() || a.name;

/** The KST date (YYYY-MM-DD) the daily-assign file of `now` is named after. */
export const kstDate = (now: number): string => new Date(now + KST_MS).toISOString().slice(0, 10);

/**
 * The bot's row of the assignment table (`| 판붕이 | 결과물 | 근거 |`, a cell may name several bots joined by ·) and
 * its last line in the results list (`- 판붕이 ✅ ...`). null for what the file does not say.
 */
export function assignmentOf(md: string, label: string): { today: string | null; result: string | null } {
  const lines = md.split("\n");
  const row = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .find((cells) => (cells[1] ?? "").split(/[·,/]/).some((n) => n.trim() === label));
  const results = lines.filter((l) => l.startsWith(`- ${label} `) || l.startsWith(`- ${label}\t`));
  const today = row?.[2] ? clip(oneLine(row[2])) : null;
  return { today, result: results.length ? clip(oneLine(results.at(-1)!.slice(2 + label.length))) : null };
}

/** A delegate answer in one line: its last line outside the hermes tool trace (lines framed with │), else the trace's first. */
export function delegateSummary(output: string): string {
  const answer = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^[│┃╭╰]/.test(l));
  return answer.length ? clip(oneLine(answer.at(-1)!)) : firstLine(output);
}

/** The last lines of delegations.jsonl; a line cut by the tail or not JSON is skipped. */
export function delegations(
  home: string,
): { at: string; agent: string; outcome: string; text: string; output: string; mission?: string }[] {
  const path = join(home, "delegations.jsonl");
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const len = Math.min(size, DELEGATION_TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf
    .toString("utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as Record<string, unknown>;
        return typeof v["agent"] === "string" && typeof v["at"] === "string"
          ? [
              {
                at: v["at"],
                agent: v["agent"],
                outcome: String(v["outcome"] ?? ""),
                text: String(v["text"] ?? ""),
                output: String(v["output"] ?? ""),
                ...(typeof v["mission"] === "string" ? { mission: v["mission"] } : {}),
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
}

/** `agents`: agents.json as read once for the whole board (none when it is missing or malformed). */
export function botCards(home: string, now: number, agents: Agent[]): BotCard[] {
  const assignFile = join(home, "out", `daily-assign-${kstDate(now)}.md`);
  const md = existsSync(assignFile) ? readFileSync(assignFile, "utf8") : "";
  const log = delegations(home);
  return agents.map((a) => {
    const label = botLabel(a);
    const last = log.filter((l) => l.agent === a.name).at(-1);
    return {
      name: a.name,
      label,
      role: a.role,
      ...assignmentOf(md, label),
      lastDelegate: last ? { at: last.at, outcome: last.outcome, summary: delegateSummary(last.output) } : null,
    };
  });
}
