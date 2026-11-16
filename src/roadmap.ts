// Project roadmaps: `$DORI_HOME/projects/<project>.md`, one per project, written by people and read by the autopilot
// (autopilot.ts) and the board. See docs/autopilot.md for the format.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `delegate`: a bot does it (documents, content, research). `pr`: a lane does it, as a backlog item ending in a PR. */
export type TaskKind = "delegate" | "pr";

export type RoadmapTask = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly kind: TaskKind;
  /** The bot named with `@name` in the line; otherwise the project's first owner does a delegate task. */
  readonly bot?: string;
  /** Set when the task asks for something only a person may do (publish, merge, deploy, pay, delete, post as 재일). */
  readonly blocked?: string;
};

export type Roadmap = {
  readonly project: string;
  readonly file: string;
  readonly title: string;
  readonly goal: string;
  readonly owners: readonly string[];
  /** owner/repo on GitHub: its commits and PRs count as activity. */
  readonly repo?: string;
  /** A local checkout: its commits count as activity, and `pr` tasks start their lane there. */
  readonly path?: string;
  /** Words that mark a delegation or lane as this project's work (the project name always counts). */
  readonly keywords: readonly string[];
  readonly doneWhen: string;
  readonly milestones: readonly string[];
  readonly tasks: readonly RoadmapTask[];
  /** The file's last edit: an edited roadmap counts as activity. */
  readonly editedAt: number;
};

const FIELDS: Record<string, "goal" | "owners" | "repo" | "path" | "keywords" | "doneWhen"> = {
  목표: "goal",
  goal: "goal",
  담당: "owners",
  owners: "owners",
  저장소: "repo",
  repo: "repo",
  경로: "path",
  path: "path",
  키워드: "keywords",
  keywords: "keywords",
  "완료 기준": "doneWhen",
  done: "doneWhen",
};

/** What the autopilot never hands out: these stay drafts until a person acts. English words match whole words only. */
const PERSON_ONLY: readonly [RegExp, string][] = [
  [/게시|발행|업로드|\b(?:publish|post to|upload)\b/i, "게시"],
  [/병합|머지|\bmerge\b/i, "병합"],
  [/배포|릴리스|\b(?:deploy|release|ota)\b/i, "배포"],
  [/결제|구매|\b(?:payment|purchase|billing)\b/i, "결제"],
  [/삭제|지우기|\b(?:delete|drop table|wipe)\b/i, "데이터 삭제"],
  [/개인 계정|재일 님 계정|\bpersonal account\b/i, "재일 님 개인 계정 글"],
];

/** "X하지 말고 Y해": X is forbidden, Y is asked. The split keeps Y, so a request after a prohibition still counts. */
const BUT_NOT = /하지 ?말고|말고|\binstead of\b/i;
const NEGATED = /하지 ?마|하지 ?말|말 것|금지|않는다|않기|\bdon'?t\b|\bdo not\b|\bnever\b/i;

/** The person-only action a task asks for; a clause that forbids it ("게시는 하지 마") does not count. */
export const personOnly = (text: string): string | undefined => {
  const asked = text
    .split(/[.!?\n;]|,\s|\(|\)/)
    .map((clause) => {
      const m = BUT_NOT.exec(clause);
      return m ? clause.slice(m.index + m[0].length) : clause;
    })
    .filter((clause) => !NEGATED.test(clause))
    .join(" ");
  return PERSON_ONLY.find(([re]) => re.test(asked))?.[1];
};

const list = (v: string): string[] =>
  v
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const taskId = (project: string, text: string): string =>
  createHash("sha256").update(`${project}\n${text}`).digest("hex").slice(0, 8);

function parseTask(project: string, mark: string, rest: string): RoadmapTask {
  const kind: TaskKind = /^\[pr\]\s*/i.test(rest) ? "pr" : "delegate";
  const text = rest.replace(/^\[pr\]\s*/i, "").trim();
  const bot = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text)?.[1];
  const blocked = personOnly(text);
  return {
    id: taskId(project, text),
    text,
    done: mark.toLowerCase() === "x",
    kind,
    ...(bot !== undefined ? { bot } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
  };
}

export function parseRoadmap(project: string, file: string, text: string, editedAt: number): Roadmap {
  const fields: Partial<Record<"goal" | "owners" | "repo" | "path" | "keywords" | "doneWhen", string>> = {};
  const milestones: string[] = [];
  const tasks: RoadmapTask[] = [];
  let title = project;
  let section = "";
  for (const line of text.split("\n")) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) title = h1[1]!.trim();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) section = h2[1]!.trim().toLowerCase();
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (task) {
      tasks.push(parseTask(project, task[1]!, task[2]!));
      continue;
    }
    const field = /^[-*]\s+([^:：]+)[:：]\s*(.*)$/.exec(line);
    const key = field ? FIELDS[field[1]!.trim()] : undefined;
    if (key && !(/마일스톤|milestone/.test(section) || /다음|next/.test(section))) fields[key] = field![2]!.trim();
    else if (/마일스톤|milestone/.test(section) && /^[-*]\s+/.test(line)) milestones.push(line.replace(/^[-*]\s+/, ""));
  }
  return {
    project,
    file,
    title,
    goal: fields.goal ?? "",
    owners: list(fields.owners ?? ""),
    ...(fields.repo ? { repo: fields.repo } : {}),
    ...(fields.path ? { path: expandHome(fields.path) } : {}),
    keywords: [...new Set([project, ...list(fields.keywords ?? "")])],
    doneWhen: fields.doneWhen ?? "",
    milestones,
    tasks,
    editedAt,
  };
}

export const projectsDir = (home: string): string => join(home, "projects");

/** Every `projects/*.md`, by file name; a file that cannot be read is skipped, never fatal to the caller. */
export function loadRoadmaps(home: string): Roadmap[] {
  const dir = projectsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      const file = join(dir, f);
      try {
        return [parseRoadmap(f.slice(0, -3), file, readFileSync(file, "utf8"), statSync(file).mtimeMs)];
      } catch {
        return [];
      }
    });
}
