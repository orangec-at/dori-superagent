import { join } from "node:path";
import { asks } from "./asks.ts";
import { tailJson } from "./board-agents.ts";
import { chatTail } from "./board-chat.ts";
import { taskTitle } from "./board-live.ts";
import type { Store } from "./store.ts";

/** The newest thing a lead did on record and its time. */
export type LeadSeen = { at: number; what: string };

type Rec = Record<string, unknown>;
/**
 * What a lead leaves in its dori home, read here from the store or on another computer over ssh: its lanes, the
 * delegate-runs.jsonl lines, its asks and the board chat. Only files that already exist; the session title never
 * counts (it is set once when a session starts and says nothing about now).
 */
export type LeadRecords = {
  readonly lanes: readonly Rec[];
  readonly runs: readonly Rec[];
  readonly asks: readonly Rec[];
  readonly chat: readonly Rec[];
};

const CHAT_LINES = 50;
/** Lane log entries only the lead writes (`dori start`, `dori adopt`, `dori done`); the rest are the lane's or duty's. */
const LANE_WORD: Record<string, string> = { start: "시작", adopt: "맡음", done: "닫음" };
/** Delegations the lead did not hand out: the autopilot's, and one bot relaying to another (`[디도 → 엔도, ...]`). */
const NOT_LEAD = /^\[(?:autopilot |[^\]\n]*→)/;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): number | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Every record as one line with its time, from the lead's lanes, delegations (not the autopilot's), asks and replies. */
function seenAll(r: LeadRecords): LeadSeen[] {
  const out: LeadSeen[] = [];
  const add = (at: number | null, what: string): void => {
    if (at !== null) out.push({ at, what });
  };
  for (const l of r.lanes)
    for (const e of Array.isArray(l["log"]) ? (l["log"] as Rec[]) : []) {
      const word = LANE_WORD[str(e?.["kind"])];
      if (word) add(num(e["at"]), `lane ${str(l["key"])} ${word}`);
    }
  for (const d of r.runs)
    if (str(d["agent"]) && !NOT_LEAD.test(str(d["text"])))
      add(iso(d["at"]), `${str(d["agent"])}에게 위임 · ${taskTitle(str(d["text"]))}`);
  for (const a of r.asks) {
    add(num(a["createdAt"]), `질문 올림 · ${str(a["id"])}`);
    add(num(a["closedAt"]), `질문 닫음 · ${str(a["id"])}`);
  }
  for (const m of r.chat) if (m["from"] === "lead") add(num(m["at"]), `답함 · ${taskTitle(str(m["text"]))}`);
  return out;
}

/** The newest of the lead's records, or null when there is none. */
export const newestSeen = (r: LeadRecords): LeadSeen | null =>
  seenAll(r).reduce<LeadSeen | null>((a, b) => (a && a.at >= b.at ? a : b), null);

/** The newest thing this board's lead did on record. */
export const leadSeen = (store: Store): LeadSeen | null =>
  newestSeen({
    lanes: store.lanes(),
    runs: tailJson(join(store.root, "delegate-runs.jsonl")),
    asks: asks(store.root),
    chat: chatTail(store.root, CHAT_LINES),
  });
