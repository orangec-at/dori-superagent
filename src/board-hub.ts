import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lanePrs } from "./board-prs.ts";
import type { Exec, ExecOptions } from "./runtime/exec.ts";
import type { Store } from "./store.ts";

/**
 * The project tab's slow facts: each PR's state from GitHub and each project's numbers from board.json `metrics`. The
 * board process collects them now and then (refreshHub) into DORI_HOME/board-hub.json; a page or a poll only reads that
 * file, so polling never runs gh or a metric command. A metric runs only the command or file board.json names (the
 * lead writes it; the page never takes one), under a time limit; one that fails or times out shows 알 수 없음.
 */
export type HubPr = { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: number | null; closedAt: number | null };
export type HubMetric = { name: string; value: string | null; at: number };
export type Hub = { generatedAt: number; prs: Record<string, HubPr>; metrics: Record<string, HubMetric[]> };
/** One board.json metric: `cmd` runs with `sh -c`, `file` is read; its first non-empty line is the value. */
export type MetricDef = { project: string; name: string; cmd: string | null; file: string | null };

export const HUB_EVERY_MS = 10 * 60_000;
export const HUB_TIMEOUT_MS = 60_000;
export const METRIC_TIMEOUT_MS = 20_000;
const KILL_AFTER_S = 2;
const KILL_GRACE_MS = (KILL_AFTER_S + 1) * 1000;
const VALUE_MAX = 80;
const PR_WINDOW_MS = 14 * 86_400_000;
const hubPath = (home: string): string => join(home, "board-hub.json");
export const prKey = (repo: string, num: number): string => `${repo.toLowerCase()}#${num}`;

/** board.json `projects.<name>.metrics`: `[{ "name", "cmd" | "file" }]`; an entry of another shape is skipped. */
export function metricDefs(home: string): MetricDef[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, "board.json"), "utf8")) as { projects?: unknown };
    const p = raw.projects;
    if (!p || typeof p !== "object" || Array.isArray(p)) return [];
    return Object.entries(p).flatMap(([project, v]) => {
      const list = v && typeof v === "object" && !Array.isArray(v) ? (v as { metrics?: unknown }).metrics : undefined;
      return (Array.isArray(list) ? list : []).flatMap((m: unknown): MetricDef[] => {
        const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
        const str = (k: string): string | null =>
          typeof o[k] === "string" && (o[k] as string).trim() !== "" ? (o[k] as string).trim() : null;
        const [name, cmd, file] = [str("name"), str("cmd"), str("file")];
        return name && (cmd === null) !== (file === null) ? [{ project, name, cmd, file }] : [];
      });
    });
  } catch {
    return [];
  }
}

const firstLine = (s: string): string | null =>
  s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "")
    ?.slice(0, VALUE_MAX) ?? null;

type Spawned = ExecOptions["onSpawn"];

/**
 * Runs `cmd` with `sh -c` under GNU `timeout`, which leads its own process group: past `timeoutMs` it signals the whole
 * group (SIGKILL 2 s later), so the pipes and ssh a compound command started die with `sh`. A `timeout` that does not
 * return within the grace is killed too, and it passes that signal on to the group. Either way the value is null.
 */
async function runMetric(exec: Exec, cmd: string, timeoutMs: number, onSpawn?: Spawned): Promise<string | null> {
  const procs: { kill(): void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs + KILL_GRACE_MS);
  });
  const limit = ["-k", String(KILL_AFTER_S), (timeoutMs / 1000).toFixed(3)];
  const run = exec("timeout", [...limit, "sh", "-c", cmd], {
    onSpawn: (p) => {
      procs.push(p);
      onSpawn?.(p);
    },
  })
    .then((r) => (r.code === 0 ? firstLine(r.stdout) : null))
    .catch(() => null);
  try {
    const v = await Promise.race([run, late]);
    if (v === null) for (const p of procs) p.kill();
    return v;
  } finally {
    clearTimeout(timer);
  }
}

function readMetricFile(home: string, file: string): string | null {
  try {
    return firstLine(readFileSync(file.startsWith("/") ? file : join(home, file), "utf8"));
  } catch {
    return null;
  }
}

type GhPr = { number: number; state: string; mergedAt: string | null; closedAt: string | null };
const time = (s: string | null): number | null => (s ? Date.parse(s) || null : null);

/** The repos of the PRs that lanes active in the last two weeks name. */
function prRepos(store: Store, now: number): string[] {
  const lanes = store.lanes().filter((l) => l.status !== "done" || now - l.lastActivityAt < PR_WINDOW_MS);
  return [...new Set(lanes.flatMap((l) => lanePrs(l).flatMap((p) => (p.repo ? [p.repo.toLowerCase()] : []))))];
}

export type CollectHubOptions = { now: number; metricTimeoutMs?: number; onSpawn?: Spawned };

/**
 * One `gh pr list` per repo and every metric. A PR this read does not return (gh failed, or it is older than the newest
 * 200) keeps the state `last` had for it.
 */
export async function collectHub(exec: Exec, store: Store, last: Hub | null, o: CollectHubOptions): Promise<Hub> {
  const prs: Record<string, HubPr> = {};
  await Promise.all(
    prRepos(store, o.now).map(async (repo) => {
      for (const [k, v] of Object.entries(last?.prs ?? {})) if (k.startsWith(`${repo}#`)) prs[k] = v;
      const argv = ["pr", "list", "--repo", repo, "--state", "all", "--limit", "200"];
      const r = await exec("gh", [...argv, "--json", "number,state,mergedAt,closedAt"], {
        ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
      }).catch(() => null);
      let list: GhPr[] | null = null;
      try {
        list = r && r.code === 0 ? (JSON.parse(r.stdout) as GhPr[]) : null;
      } catch {
        list = null;
      }
      for (const p of list ?? []) {
        const state = p.state === "MERGED" || p.state === "CLOSED" ? p.state : "OPEN";
        prs[prKey(repo, p.number)] = { state, mergedAt: time(p.mergedAt), closedAt: time(p.closedAt) };
      }
    }),
  );
  const metrics: Record<string, HubMetric[]> = {};
  const defs = metricDefs(store.root);
  const values = await Promise.all(
    defs.map((m) =>
      m.cmd !== null
        ? runMetric(exec, m.cmd, o.metricTimeoutMs ?? METRIC_TIMEOUT_MS, o.onSpawn)
        : Promise.resolve(readMetricFile(store.root, m.file ?? "")),
    ),
  );
  defs.forEach((m, i) => {
    metrics[m.project] = [...(metrics[m.project] ?? []), { name: m.name, value: values[i] ?? null, at: o.now }];
  });
  return { generatedAt: o.now, prs, metrics };
}

export function saveHub(home: string, h: Hub): void {
  const path = hubPath(home);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(h)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** The last collected facts, or null when never collected or unreadable. */
export function readHub(home: string): Hub | null {
  try {
    if (!existsSync(hubPath(home))) return null;
    const h = JSON.parse(readFileSync(hubPath(home), "utf8")) as Hub;
    return typeof h.generatedAt === "number" && h.prs && h.metrics ? h : null;
  } catch {
    return null;
  }
}

/**
 * Collects and saves, for the board process. Past `timeoutMs` the gh and metric processes still running are killed and
 * the last saved facts stay. Returns a `hub: ...` line on failure, else null.
 */
export async function refreshHub(exec: Exec, store: Store, now: number, timeoutMs = HUB_TIMEOUT_MS) {
  const procs = new Set<{ kill(): void }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    const last = readHub(store.root);
    const h = await Promise.race([collectHub(exec, store, last, { now, onSpawn: (p) => procs.add(p) }), late]);
    if (h === "late") {
      for (const p of procs) p.kill();
      return `hub: 프로젝트 현황 갱신 시간 초과 (${Math.ceil(timeoutMs / 1000)}초), 지난 값을 그대로 둠`;
    }
    saveHub(store.root, h);
    return null;
  } catch (e) {
    return `hub: 프로젝트 현황 갱신 실패 ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160)}`;
  } finally {
    clearTimeout(timer);
  }
}
