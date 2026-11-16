// Stall detection: a project with no commit, PR, delegation, lane or roadmap edit for 24 hours is reported to the lead
// and gets its next roadmap task handed out: a backlog item (a lane, then a PR) or a delegation (documents, content).
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { backlogAdd } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import type { Assignment, DelegateRun, ProjectActivity } from "./autopilot-store.ts";
import { taskTag } from "./autopilot-outcomes.ts";
import { recordAssignment, writeBrief } from "./autopilot-store.ts";
import type { Roadmap, RoadmapTask } from "./roadmap.ts";
import { KEY_RE } from "./store-types.ts";

export const STALL_HOURS = 24;

const newer = (a: ProjectActivity, at: number, source: string): ProjectActivity =>
  Number.isFinite(at) && at > a.at ? { at, source } : a;

/** Bound on one git or gh call, so a hung network never holds up the duty pass that runs the check. */
export const ASK_TIMEOUT_MS = 10_000;

async function ask(d: Deps, cmd: string, argv: string[], timeoutMs: number): Promise<string> {
  let proc: { kill(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = d.exec(cmd, argv, { onSpawn: (p) => (proc = p) }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const expired = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
  const r = await Promise.race([run, expired]);
  clearTimeout(timer);
  if (r === "timeout") {
    proc?.kill();
    return "";
  }
  return r.code === 0 ? r.stdout.trim() : "";
}

/** The project's newest activity of every kind dori can see. A source that fails (gh down, no checkout) is skipped. */
export async function lastActivity(
  d: Deps,
  r: Roadmap,
  runs: readonly DelegateRun[],
  assignments: readonly Assignment[],
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<ProjectActivity> {
  let a: ProjectActivity = { at: r.editedAt, source: "로드맵 수정" };
  const words = r.keywords.map((k) => k.toLowerCase());
  const mentions = (text: string): boolean => words.some((w) => text.toLowerCase().includes(w));
  for (const run of runs) if (mentions(run.text)) a = newer(a, run.endedAt ?? run.at, `${run.agent} 위임`);
  for (const x of assignments) if (x.project === r.project) a = newer(a, x.at, "autopilot 배정");
  for (const lane of d.store.lanes()) {
    const ours =
      mentions(lane.key) || (r.path !== undefined && (lane.cwd === r.path || lane.cwd.startsWith(r.path + sep)));
    if (ours) a = newer(a, lane.lastActivityAt, `lane ${lane.key}`);
  }
  const local = r.path !== undefined && existsSync(r.path);
  const remote = r.repo !== undefined && /^[\w.-]+\/[\w.-]+$/.test(r.repo);
  const prArgs = ["pr", "list", "--repo", String(r.repo), "--state", "all", "--limit", "1"];
  const [ct, commit, pr] = await Promise.all([
    local ? ask(d, "git", ["-C", r.path!, "log", "-1", "--all", "--format=%ct"], timeoutMs) : "",
    remote
      ? ask(d, "gh", ["api", `repos/${r.repo}/commits?per_page=1`, "--jq", ".[0].commit.committer.date"], timeoutMs)
      : "",
    remote ? ask(d, "gh", [...prArgs, "--json", "updatedAt", "--jq", ".[0].updatedAt"], timeoutMs) : "",
  ]);
  if (Number(ct) > 0) a = newer(a, Number(ct) * 1000, "커밋");
  a = newer(a, Date.parse(commit), "커밋");
  a = newer(a, Date.parse(pr), "PR");
  return a;
}

/** The next task nobody was handed yet and a bot or lane may do; person-only tasks are skipped. */
export const nextTask = (r: Roadmap, assigned: ReadonlySet<string>): RoadmapTask | undefined =>
  r.tasks.find((t) => !t.done && t.blocked === undefined && !assigned.has(`${r.project}:${t.id}`));

const itemId = (r: Roadmap, t: RoadmapTask): string | undefined => {
  const slug = r.project
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const id = `ap-${slug}-${t.id}`;
  return KEY_RE.test(id) ? id : undefined;
};

/** The roadmap context a lane or bot needs, and the rule that it stops at a draft or a PR. */
export const taskContext = (r: Roadmap): string =>
  [
    `로드맵: ${r.file}`,
    r.goal ? `프로젝트 목표: ${r.goal}` : "",
    r.doneWhen ? `완료 기준: ${r.doneWhen}` : "",
    "규칙: 초안·PR까지만. 게시·병합·배포·결제·데이터 삭제·재일 님 개인 계정 글은 하지 말고 사람에게 넘겨.",
  ]
    .filter(Boolean)
    .join("\n");

/**
 * Hands out a stalled project's next task. A `pr` task becomes a backlog item (autostart opens its lane in the same
 * duty pass); a delegate task goes to its bot through `launch`. Returns what was created, for the lead's report.
 */
export function handOut(
  d: Deps,
  r: Roadmap,
  t: RoadmapTask,
  launch: (bot: string, text: string, mission?: string) => void,
  bots: ReadonlySet<string>,
): string {
  const home = d.store.root;
  const base = { at: d.now(), project: r.project, task: t.id, text: t.text, reason: "stall" as const };
  if (t.kind === "pr") {
    const id = itemId(r, t);
    if (id === undefined) return `[pr] ${t.text}: 프로젝트 이름으로 backlog id를 만들 수 없음`;
    if (r.path === undefined || !existsSync(r.path))
      return `[pr] ${t.text}: 로드맵에 있는 경로(저장소 체크아웃)가 없음`;
    const brief = writeBrief(
      home,
      id,
      `# ${r.title}: ${t.text}\n\n자동 생성: 프로젝트 정체 감지(autopilot).\n${taskContext(r)}\n`,
    );
    try {
      backlogAdd(d, id, brief, { title: `${r.project}: ${t.text}`.slice(0, 120), cwd: r.path });
    } catch (e) {
      return `[pr] ${t.text}: backlog 추가 실패 (${e instanceof Error ? e.message : String(e)})`;
    }
    recordAssignment(home, { ...base, kind: "backlog", item: id });
    return `backlog ${id} (${t.text})`;
  }
  const bot = t.bot ?? r.owners[0];
  if (bot === undefined) return `${t.text}: 담당 봇이 없음`;
  if (!bots.has(bot)) return `${t.text}: ${bot}가 agents.json에 없어 넘기지 않음`;
  const mission = `autopilot-${r.project}`;
  launch(bot, delegateText(r, t), KEY_RE.test(mission) ? mission : undefined);
  recordAssignment(home, { ...base, kind: "delegate", bot });
  return `${bot}에게 위임 (${t.text})`;
}

export const delegateText = (r: Roadmap, t: RoadmapTask): string =>
  `${taskTag(r.project, t.id)} ${t.text}\n\n${taskContext(r)}\n끝나면 결과 파일 경로나 링크를 회신해.`;
