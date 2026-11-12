// The hourly loop's board check: open issues on the team board that are new, or got a comment that is not the lead's,
// since the last check. Read-only: its one call is `gh issue list`. See docs/hourly-loop.md.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { HOUR } from "./loop-audit.ts";

const DEFAULT_REPO = "orangec-at/team-board";
/**
 * Every bot and the lead post as the same GitHub account, so the author tells nothing. The lead opens its own board
 * comments with "도리도라 회신" (an answer) or "도리도라 기록" (a log entry); a bot writing to the lead does not.
 */
const LEAD_RE = /^\s*도리도라\s*(회신|기록)/;

type GhComment = { body: string; createdAt: string };
type GhIssue = { number: number; title: string; url: string; createdAt: string; comments: GhComment[] };
type Seen = { repo: string; since: number };

const oneLine = (s: string): string => s.trim().split("\n")[0]!.slice(0, 160);

function readConfigRepo(root: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, "config.json"), "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return undefined;
    throw e;
  }
  const value: unknown = (JSON.parse(text) as { boardRepo?: unknown }).boardRepo;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`config.json: "boardRepo" must be a string`);
  return value;
}

/** `DORI_BOARD_REPO`, else `boardRepo` in config.json, else orangec-at/team-board; "off" turns the check off. */
function boardRepo(root: string): string | undefined {
  const repo = process.env["DORI_BOARD_REPO"] || readConfigRepo(root) || DEFAULT_REPO;
  return repo === "off" ? undefined : repo;
}

function readSeen(path: string): Seen | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Seen;
  } catch {
    return undefined;
  }
}

/**
 * One `board: ...` line per open issue opened, or commented on by someone other than the lead, after the last check;
 * `board: 확인 실패 <reason>` when gh or the config fails (the state is then left as it was, so nothing is lost).
 * "After the last check" means newer than the newest issue or comment the last successful check saw, so GitHub's
 * clock is compared only with itself. The first check, with no state, looks back one hour.
 */
export async function checkBoard(d: Deps): Promise<string[]> {
  try {
    const repo = boardRepo(d.store.root);
    if (!repo) return [];
    const r = await d.exec("gh", [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,createdAt,comments",
    ]);
    if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `gh exit ${r.code}`);
    const issues = JSON.parse(r.stdout) as GhIssue[];
    const dir = join(d.store.root, "loop");
    const path = join(dir, "board-seen.json");
    const seen = readSeen(path);
    const since = seen?.repo === repo ? seen.since : d.now() - HOUR;
    let newest = since;
    const lines: string[] = [];
    for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
      for (const at of [issue.createdAt, ...issue.comments.map((c) => c.createdAt)])
        newest = Math.max(newest, Date.parse(at));
      const fresh = issue.comments.filter((c) => Date.parse(c.createdAt) > since && !LEAD_RE.test(c.body)).length;
      const what = Date.parse(issue.createdAt) > since ? "새 이슈" : fresh > 0 ? `새 댓글 ${fresh}` : undefined;
      if (what) lines.push(`board: #${issue.number} ${issue.title} (${what}) ${issue.url}`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ repo, since: newest } satisfies Seen)}\n`);
    renameSync(`${path}.tmp`, path);
    return lines;
  } catch (e) {
    return [`board: 확인 실패 ${oneLine(e instanceof Error ? e.message : String(e))}`];
  }
}
