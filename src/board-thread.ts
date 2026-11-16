import type { Ask } from "./asks.ts";
import type { Pr } from "./board-prs.ts";
import { delegateSummary, delegations, firstLine } from "./board-bots.ts";
import type { BoardState } from "./board-state.ts";
import { type Row, rows } from "./board-status.ts";
import type { Store } from "./store.ts";

/**
 * One item of a record: `me` is the operator (right bubble), `them` an answer (plain text on the left), `work` a
 * collapsed progress row (a lane step, a delegation), `ask` a decision card, `note` a quiet line.
 */
export type ThreadItem =
  | { t: "me"; at: number; text: string; delivery?: string }
  | { t: "them"; at: number | null; text: string; links?: string[] }
  | { t: "work"; at: number | null; title: string; body: string; href?: string }
  | { t: "ask"; ask: Ask }
  | { t: "note"; text: string };

/** The selected row's record: what waits on the operator, its timeline, and the PRs it opened. */
export type Thread = { row: Row; rows: Row[]; waiting: ThreadItem[]; items: ThreadItem[]; prs: Pr[] };

const DELEGATIONS_SHOWN = 8;
const BODY_MAX = 4000;
const ANSWER_KINDS = new Set(["report", "ready", "done", "escalate"]);

const tail = (s: string, n = BODY_MAX): string => (s.length > n ? `…${s.slice(-n)}` : s);

function lead(s: BoardState, all: Row[]): Omit<Thread, "row" | "rows"> {
  const waiting: ThreadItem[] = s.asks.filter((a) => !a.sent).map((ask) => ({ t: "ask", ask }));
  for (const r of all)
    if (r.kind === "lane" && r.section === "needs")
      waiting.push({ t: "work", at: r.at, title: `${r.title} · ${r.word}`, body: r.line, href: `/?c=${r.id}` });
  const items: ThreadItem[] = s.chat.map((m) =>
    m.from === "operator"
      ? { t: "me", at: m.at, text: m.text, ...(m.delivery ? { delivery: m.delivery } : {}) }
      : { t: "them", at: m.at, text: m.text },
  );
  for (const ask of s.asks.filter((a) => a.sent)) items.push({ t: "ask", ask });
  if (items.length === 0)
    items.push({ t: "note", text: "아직 대화가 없어요. 아래에 적으면 도리도라에게 가고, 답은 여기로 와요." });
  const prs = all.filter((r) => r.kind === "lane" && r.section === "needs").flatMap((r) => r.prs);
  return { waiting, items, prs };
}

function bot(store: Store, s: BoardState, name: string): ThreadItem[] {
  const b = s.bots.find((x) => x.name === name);
  if (!b) return [{ t: "note", text: "agents.json에 없는 봇이에요." }];
  const items: ThreadItem[] = [];
  for (const d of delegations(store.root)
    .filter((x) => x.agent === name)
    .slice(-DELEGATIONS_SHOWN)) {
    const at = Date.parse(d.at);
    items.push({
      t: "work",
      at,
      title: `지시 · ${d.outcome}`,
      body: `${tail(d.text, 1500)}\n\n── 출력 ──\n${tail(d.output)}`,
    });
    items.push({ t: "them", at, text: delegateSummary(d.output) || "출력 없음" });
  }
  items.push({ t: "note", text: `오늘 배정: ${b.today ?? "기록 없음"}` });
  if (b.result) items.push({ t: "them", at: null, text: `오늘 결과: ${b.result}` });
  return items;
}

function lane(store: Store, key: string): ThreadItem[] {
  const l = store.lane(key);
  if (!l) return [{ t: "note", text: "이 lane은 더 이상 없어요." }];
  const items: ThreadItem[] = l.log.map((e) =>
    ANSWER_KINDS.has(e.kind)
      ? { t: "them", at: e.at, text: e.text }
      : { t: "work", at: e.at, title: `${e.kind} · ${firstLine(e.text)}`, body: e.text },
  );
  if (l.final) items.push({ t: "them", at: l.final.at, text: l.final.text, links: l.final.evidence });
  return items.length ? items : [{ t: "note", text: "아직 기록이 없어요." }];
}

function standing(s: BoardState, all: Row[], domain: string): ThreadItem[] {
  const c = s.standing.find((x) => x.domain === domain);
  if (!c) return [{ t: "note", text: s.standingError ?? "leads.json에 없는 상시 리드예요." }];
  const text = c.on
    ? `실행 중 (${c.pane}). 맡은 lane ${c.lanes}개, 시범 ${c.trialDaysLeft}일 남음.`
    : `꺼져 있어요.${c.stopReason ? ` 이유: ${c.stopReason}` : ""}`;
  const items: ThreadItem[] = [{ t: "them", at: c.since, text }];
  for (const r of all)
    if (r.kind === "lane" && r.project === domain && r.section !== "unread")
      items.push({ t: "work", at: r.at, title: `${r.title} · ${r.word}`, body: r.line, href: `/?c=${r.id}` });
  return items;
}

/** The record of row `id`: an ask opens the lead's record, an unknown id the lead's too. */
export function threadOf(store: Store, s: BoardState, id: string): Thread {
  const all = rows(s, s.generatedAt);
  const row = all.find((r) => r.id === id && r.kind !== "ask") ?? all[0]!;
  const [kind, name = ""] = row.id.split(/:(.*)/s);
  const none = { waiting: [] as ThreadItem[], prs: row.prs };
  const rest =
    kind === "bot"
      ? { ...none, items: bot(store, s, name) }
      : kind === "lane"
        ? {
            ...none,
            waiting: row.section === "needs" ? [{ t: "them" as const, at: row.at, text: row.line }] : [],
            items: lane(store, name),
          }
        : kind === "standing"
          ? { ...none, items: standing(s, all, name) }
          : lead(s, all);
  return { row, rows: all, ...rest };
}
