import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type BotCard,
  DELEGATION_TAIL_BYTES,
  decodeEscapes,
  delegateSummary,
  delegations,
  firstLine,
} from "./board-bots.ts";
import type { ChatMessage } from "./board-chat.ts";
import { briefTitle } from "./board-hub-state.ts";
import { museInbox } from "./board-mission-sources.ts";
import { lanePrs } from "./board-prs.ts";
import { NO_ASSIGNMENT } from "./board-status.ts";
import type { Store } from "./store.ts";

/**
 * The 에이전트 tab: one row per agent saying whether it is at work, waiting or silent, what it is doing in one line and
 * when it last did something. Read only from files the harness already writes; a fact no file records is shown as
 * 기록 없음 (null), never guessed.
 */
export type AgentState = "working" | "waiting" | "silent";
export const STATE_WORD: Record<AgentState, string> = { working: "작업 중", waiting: "대기", silent: "응답 없음" };
export type AgentLink = { label: string; href: string };
/** `href`: the agent's record on the board (none for Muse); `detail`: the lines its row unfolds to. */
export type AgentActivity = {
  id: string;
  kind: "lead" | "lane" | "bot" | "muse";
  name: string;
  sub: string;
  state: AgentState | null;
  line: string | null;
  detail: string[];
  at: number | null;
  links: AgentLink[];
  href: string | null;
};

/** Activity older than this is dimmed on the tab. */
export const STALE_MS = 24 * 3_600_000;
/** A working lane this quiet has stopped answering (the same two hours the work tab calls 조용함). */
const LANE_QUIET_MS = 2 * 3_600_000;
/** The operator's message the lead has not answered in this long. */
const LEAD_ANSWER_MS = 30 * 60_000;
/** A request Muse has not answered in this long. */
const MUSE_ANSWER_MS = 6 * 3_600_000;
/** A delegation still open this long past its timeout: the process that ran it died without writing its end. */
const RUN_GRACE_MS = 60_000;
const TAIL_BYTES = 256 * 1024;
const LINKS_MAX = 3;

const one = (s: string): string => firstLine(decodeEscapes(s));
const urls = (s: string): string[] => [...new Set(s.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])].slice(0, LINKS_MAX);

/** The parsed JSON objects of a file's last lines; a line cut by the tail or not JSON is skipped. */
function tailJson(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, size - buf.length);
  } finally {
    closeSync(fd);
  }
  return buf
    .toString("utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as unknown;
        return v && typeof v === "object" && !Array.isArray(v) ? [v as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

export type RunningDelegation = { at: string; agent: string; text: string; until: number };

/**
 * Delegations started (delegate-runs.jsonl) whose end (the delegations.jsonl line with the same at and agent) is not
 * written. The end lines carry the agent's output and so fill the tail read far sooner than the start lines: once
 * delegations.jsonl is longer than its tail, a start older than the oldest end read is not counted, its end may simply
 * be out of reach.
 */
export function runningDelegations(home: string): RunningDelegation[] {
  const ends = delegations(home);
  const ended = new Set(ends.map((d) => `${d.agent} ${d.at}`));
  const path = join(home, "delegations.jsonl");
  const cut = existsSync(path) && statSync(path).size > DELEGATION_TAIL_BYTES && ends.length > 0;
  const oldest = cut ? Math.min(...ends.map((d) => Date.parse(d.at))) : Number.NEGATIVE_INFINITY;
  return tailJson(join(home, "delegate-runs.jsonl")).flatMap((v) => {
    const [at, agent, until] = [v["at"], v["agent"], Date.parse(String(v["until"]))];
    if (typeof at !== "string" || typeof agent !== "string" || Number.isNaN(until) || ended.has(`${agent} ${at}`))
      return [];
    if (!(Date.parse(at) >= oldest)) return [];
    return [{ at, agent, text: String(v["text"] ?? ""), until }];
  });
}

function lead(chat: ChatMessage[], working: number, now: number): AgentActivity {
  const last = chat.at(-1);
  const asked = last?.from === "operator";
  const state: AgentState | null = !last
    ? null
    : !asked
      ? "waiting"
      : now - last.at < LEAD_ANSWER_MS
        ? "working"
        : "silent";
  const say = last ? one(last.text) : "";
  return {
    id: "lead",
    kind: "lead",
    name: "도리도라",
    sub: `리드 · lane ${working}개 진행 중`,
    state,
    line: !last ? null : !asked ? `답함 · ${say}` : state === "working" ? `요청 처리 중 · ${say}` : `답 없음 · ${say}`,
    detail: last ? [`${asked ? "재일 님" : "도리도라"}: ${decodeEscapes(last.text).trim()}`] : [],
    at: last?.at ?? null,
    links: [],
    href: "/?c=lead",
  };
}

function lanes(store: Store, now: number): AgentActivity[] {
  return store
    .lanes()
    .filter((l) => l.status !== "done")
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((l) => {
      const title = briefTitle(l.brief, l.key);
      const report = l.log.filter((e) => e.kind === "report").at(-1);
      const state: AgentState =
        l.status === "lost" || (l.status === "working" && now - l.lastActivityAt > LANE_QUIET_MS)
          ? "silent"
          : l.status === "working"
            ? "working"
            : "waiting";
      const said = l.status === "ready" && l.final ? `READY ${one(l.final.text)}` : report ? one(report.text) : "";
      return {
        id: `lane:${l.key}`,
        kind: "lane",
        name: l.key,
        sub: `lane · 패널 ${l.paneId || "기록 없음"}`,
        state,
        line: [title, said].filter(Boolean).join(" — ") || null,
        detail: [
          `브리프: ${title ?? "기록 없음"}`,
          `최근 보고: ${report ? one(report.text) : "기록 없음"}`,
          ...(l.status === "ready" && l.final ? [`READY: ${one(l.final.text)}`] : []),
        ],
        at: l.lastActivityAt,
        links: lanePrs(l).flatMap((p) => (p.url ? [{ label: `PR #${p.num}`, href: p.url }] : [])),
        href: `/?c=${encodeURIComponent(`lane:${l.key}`)}`,
      };
    });
}

function bot(b: BotCard, log: ReturnType<typeof delegations>, running: RunningDelegation[], now: number) {
  const last = log.filter((d) => d.agent === b.name).at(-1);
  // A run that died without its end is forgotten once a later delegation to the same bot ends.
  const run = running.filter((r) => r.agent === b.name && (!last || Date.parse(r.at) > Date.parse(last.at))).at(-1);
  const assigned = b.today !== null && !NO_ASSIGNMENT.test(b.today);
  const answered = last
    ? last.outcome === "ok"
      ? "답함"
      : last.outcome === "timeout"
        ? "답 없음(시간 초과)"
        : "실패"
    : "";
  const state: AgentState | null = run
    ? now <= run.until + RUN_GRACE_MS
      ? "working"
      : "silent"
    : last
      ? last.outcome === "ok"
        ? "waiting"
        : "silent"
      : assigned
        ? "waiting"
        : null;
  const activity: AgentActivity = {
    id: `bot:${b.name}`,
    kind: "bot",
    name: b.label,
    sub: `${b.role || "봇"} · 오늘: ${b.today ?? "배정 기록 없음"}`,
    state,
    line: run ? `지시: ${one(run.text)} · 답 기다리는 중` : last ? `지시: ${one(last.text)} · ${answered}` : null,
    detail: [
      `오늘 배정: ${b.today ?? "기록 없음"}`,
      ...(b.result ? [`오늘 결과: ${b.result}`] : []),
      ...(last ? [`마지막 답: ${last.outcome === "ok" ? delegateSummary(last.output) : answered}`] : []),
    ],
    at: run ? Date.parse(run.at) : last ? Date.parse(last.at) : null,
    links: last ? urls(last.output).map((href) => ({ label: href.replace(/^https?:\/\//, ""), href })) : [],
    href: `/?c=${encodeURIComponent(`bot:${b.name}`)}`,
  };
  return activity;
}

/** audit.jsonl times look like 2026-11-16T21:11:53+0900; the offset gets its colon so every engine parses it. */
const auditTime = (v: unknown): number => Date.parse(String(v).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

/** Muse: only the last request the lead handed over and whether Muse sent anything back since. */
function muse(home: string, now: number): AgentActivity[] {
  if (!existsSync(join(home, "muse"))) return [];
  const last = museInbox(home).at(-1);
  const sends = tailJson(join(home, "muse", "audit.jsonl"))
    .filter((v) => Array.isArray(v["cmd"]) && v["cmd"][0] === "send")
    .map((v) => auditTime(v["at"]))
    .filter((t) => !Number.isNaN(t));
  const reply = last ? sends.filter((t) => t > last.at).at(-1) : undefined;
  const state: AgentState | null = !last
    ? null
    : reply !== undefined
      ? "waiting"
      : now - last.at < MUSE_ANSWER_MS
        ? "working"
        : "silent";
  return [
    {
      id: "muse",
      kind: "muse",
      name: "Muse",
      sub: `외부 협업 · ${!last ? "요청 기록 없음" : reply !== undefined ? "회신 받음" : "회신 대기"}`,
      state,
      line: last ? `요청: ${one(last.text)}` : null,
      detail: last ? [`마지막 요청: ${decodeEscapes(last.text).trim()}`] : [],
      at: reply ?? last?.at ?? null,
      links: [],
      href: null,
    },
  ];
}

/** Every agent: the lead, its open lanes, the bots of agents.json and Muse when DORI_HOME has a Muse inbox. */
export function agentActivity(store: Store, now: number, bots: BotCard[], chat: ChatMessage[]): AgentActivity[] {
  const open = lanes(store, now);
  const log = delegations(store.root);
  const running = runningDelegations(store.root);
  return [
    lead(chat, open.filter((l) => l.state === "working").length, now),
    ...open,
    ...bots.map((b) => bot(b, log, running, now)),
    ...muse(store.root, now),
  ];
}
