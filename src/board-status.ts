import { type BotCard, decodeEscapes } from "./board-bots.ts";
import type { BoardState, ProjectLane } from "./board-state.ts";
import type { Pr } from "./board-prs.ts";
import { Refusal } from "./refusal.ts";
import { DAY, isOn, leadState, loadLeads, ownedLanes } from "./standing.ts";
import type { Store } from "./store.ts";

export type Health = "ok" | "idle" | "stuck" | "error";
/** Where a row is listed: the operator's turn, a fresh result, at work, worth another look, or resting. */
export type Section = "needs" | "unread" | "working" | "revisit" | "idle";

/** One row of the board: who, its status word and one line on what it needs or how far it got. */
export type Row = {
  id: string;
  kind: "lead" | "ask" | "lane" | "bot" | "standing";
  title: string;
  project: string;
  word: string;
  line: string;
  health: Health;
  section: Section;
  at: number | null;
  prs: Pr[];
};

export type StandingCard = {
  domain: string;
  on: boolean;
  pane: string | null;
  trialDaysLeft: number | null;
  lanes: number;
  since: number | null;
  stopReason: string | null;
};

/** A lane `working` this long without activity is shown as stalled. */
const QUIET_MS = 2 * 3_600_000;
/** Past noon KST a bot with an assignment and nothing delegated since midnight KST is shown as stalled. */
const KST_MS = 9 * 3_600_000;
const NOON_MS = 12 * 3_600_000;
const NO_ASSIGNMENT = /^배정 없음|^-$/;

export function standingCards(store: Store, now: number): { cards: StandingCard[]; error: string | null } {
  let defs: ReturnType<typeof loadLeads>;
  try {
    defs = loadLeads(store.root);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { cards: [], error: e.message };
  }
  const cards = defs.map((def) => {
    const s = leadState(store.root, def.domain);
    const on = isOn(s);
    return {
      domain: def.domain,
      on,
      pane: on ? s.sessionRef.id : null,
      trialDaysLeft: on ? Math.max(0, Math.ceil((s.trialEndsAt - now) / DAY)) : null,
      lanes: ownedLanes(store, def),
      since: (on ? s.startedAt : s?.stoppedAt) ?? null,
      stopReason: s?.stopReason ?? null,
    };
  });
  return { cards, error: null };
}

export function botStatus(b: BotCard, now: number): [Health, Section, string] {
  if (b.lastDelegate && b.lastDelegate.outcome !== "ok") return ["error", "revisit", "오류"];
  if (b.result?.startsWith("❌")) return ["error", "revisit", "실패"];
  if (b.result?.startsWith("⚠️")) return ["stuck", "revisit", "막힘"];
  if (b.result) return ["ok", "unread", "결과"];
  if (!b.today || NO_ASSIGNMENT.test(b.today)) return ["idle", "idle", "배정 없음"];
  const dayStart = Math.floor((now + KST_MS) / DAY) * DAY - KST_MS;
  const last = b.lastDelegate ? Date.parse(b.lastDelegate.at) : 0;
  if (last < dayStart && now - dayStart > NOON_MS) return ["stuck", "revisit", "시작 안 함"];
  return ["ok", "working", "진행 중"];
}

export function laneStatus(l: ProjectLane, now: number): [Health, Section, string] {
  if (l.escalated && l.status !== "done") return ["stuck", "needs", "ESCALATE"];
  switch (l.status) {
    case "working":
      return now - l.at > QUIET_MS ? ["stuck", "revisit", "조용함"] : ["ok", "working", "작업 중"];
    case "waiting":
      return ["stuck", "needs", "답 기다림"];
    case "lost":
      return ["error", "revisit", "끊김"];
    case "ready":
      return ["ok", "needs", l.prs.length ? "머지 승인" : "확인"];
    default:
      return ["idle", "unread", "완료"];
  }
}

const oneLine = (s: string): string => decodeEscapes(s).replace(/\s+/g, " ").trim().slice(0, 140);

/** Every row of the board, newest first inside a section; the lead's conversation is its own row. */
export function rows(s: BoardState, now: number): Row[] {
  const last = s.chat.at(-1);
  const lead: Row = {
    id: "lead",
    kind: "lead",
    title: "도리도라",
    project: "lead",
    word: last?.from === "lead" ? "답 옴" : "대화",
    line: last ? oneLine(last.text) : "시킬 일이나 물어볼 것을 보내 보세요",
    health: last?.from === "lead" ? "ok" : "idle",
    section: last?.from === "lead" ? "unread" : "idle",
    at: last?.at ?? null,
    prs: [],
  };
  const asks: Row[] = s.asks.map((a) => ({
    id: `ask:${a.id}`,
    kind: "ask",
    title: a.question,
    project: "lead",
    word: a.sent ? `보냄 ${a.sent.choice}` : "결정",
    line: a.recommend ? `추천 ${a.recommend}. ${a.options.find((o) => o.key === a.recommend)?.text ?? ""}` : a.id,
    health: a.sent ? "idle" : "stuck",
    section: a.sent ? "idle" : "needs",
    at: a.createdAt,
    prs: [],
  }));
  const standing: Row[] = s.standingError
    ? [
        {
          id: "standing",
          kind: "standing",
          title: "상시 리드",
          project: "leads.json",
          word: "설정 오류",
          line: s.standingError,
          health: "error",
          section: "revisit",
          at: null,
          prs: [],
        },
      ]
    : s.standing.map((c) => ({
        id: `standing:${c.domain}`,
        kind: "standing",
        title: `${c.domain} 상시 리드`,
        project: c.domain,
        word: c.on ? "실행 중" : c.stopReason ? "멈춤" : "꺼짐",
        line: c.on ? `lane ${c.lanes}개 맡음 · 시범 ${c.trialDaysLeft}일 남음` : (c.stopReason ?? "꺼져 있어요"),
        health: c.on ? "ok" : c.stopReason ? "stuck" : "idle",
        section: c.on ? "working" : c.stopReason ? "revisit" : "idle",
        at: c.since,
        prs: [],
      }));
  const bots: Row[] = s.bots.map((b) => {
    const [health, section, word] = botStatus(b, now);
    return {
      id: `bot:${b.name}`,
      kind: "bot",
      title: b.label,
      project: b.role,
      word,
      line: oneLine(b.result ?? b.today ?? b.lastDelegate?.summary ?? "기록 없음"),
      health,
      section,
      at: b.lastDelegate ? Date.parse(b.lastDelegate.at) : null,
      prs: [],
    };
  });
  const lanes: Row[] = s.projects.flatMap((g) =>
    [...g.lanes, ...g.done.filter((l) => !l.item)].map((l) => {
      const [health, section, word] = laneStatus(l, now);
      return {
        id: `lane:${l.key}`,
        kind: "lane",
        title: l.key,
        project: g.name,
        word,
        line: l.first,
        health,
        section,
        at: l.at,
        prs: l.prs,
      };
    }),
  );
  const listed = [...asks, ...standing, ...bots, ...lanes].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return [lead, ...listed];
}
