import { createHash } from "node:crypto";
import type { Channel, ChannelMessage } from "./channel-source.ts";

/** A Slack message as conversations.history/replies return it, the text a board page may show, and the kept copy. */
export type SlackRaw = {
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  files?: { name?: string }[];
  attachments?: { title?: string; text?: string; fallback?: string }[];
};
export type SlackStored = ChannelMessage & { id: string };

/** What the board puts in front of a message it sends, so the copy knows it as the operator's. */
export const BOARD_MARK = "*재일 (보드)*";
const TEXT_MAX = 4_000;
const KEEP = 100;
const QUIET = new Set(["channel_join", "channel_leave", "channel_purpose", "channel_topic", "bot_add", "bot_remove"]);

export const tsNum = (ts: string): number => Number(ts) || 0;

/**
 * Message text a page may show: user mentions as names, channel links as #name, links as their label, Slack's &amp;
 * escapes undone, webhook URLs and every id-like token masked.
 */
export function maskSlack(m: SlackRaw, users: Map<string, string>): string {
  let t = m.text ?? "";
  for (const f of m.files ?? []) t += `\n[첨부] ${f.name ?? "파일"}`;
  for (const a of m.attachments ?? []) {
    const card = [a.title, a.text ?? a.fallback].filter(Boolean).join(" · ");
    if (card) t += `\n[카드] ${card}`;
  }
  return t
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${users.get(id) ?? "누군가"}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<#[A-Z0-9]+>/g, "#채널")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, n?: string) => n ?? "@그룹")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/https?:\/\/hooks\.slack\.com\/\S+/gi, "(webhook)")
    .replace(/https?:\/\/\S*discord(?:app)?\.com\/api\/webhooks\/\S+/gi, "(webhook)")
    .replace(/\bx(?:ox|app)[a-z]?-[\w-]+/gi, "(token)")
    .replace(/\b[UWCGDB](?=[A-Z0-9]*\d)[A-Z0-9]{8,12}\b/g, "(ID)")
    .replace(/\b\d{17,20}\b/g, "(ID)")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
    .slice(0, TEXT_MAX);
}

export const authorOf = (m: SlackRaw, users: Map<string, string>): string =>
  (m.user ? users.get(m.user) : undefined) ?? m.bot_profile?.name ?? m.username ?? "알 수 없음";

/**
 * Adds the messages a channel or thread does not have yet, newest KEEP kept; true when any was added. Joins and topic
 * changes are left out. `advance` moves the read cursor; a message the board sent must not (one before it would be
 * skipped).
 */
export function mergeSlack(
  ch: { after: string | null; messages: SlackStored[] },
  raws: SlackRaw[],
  advance: boolean,
  o: { users: Map<string, string>; mine: string[]; now: number },
): boolean {
  const have = new Set(ch.messages.map((m) => m.id));
  for (const r of raws) if (advance && (ch.after === null || tsNum(r.ts) > tsNum(ch.after))) ch.after = r.ts;
  const fresh = raws.filter((r) => typeof r.ts === "string" && !have.has(r.ts) && !QUIET.has(r.subtype ?? ""));
  if (!fresh.length) return false;
  for (const r of fresh) {
    const text = maskSlack(r, o.users);
    ch.messages.push({
      id: r.ts,
      at: Math.round(tsNum(r.ts) * 1000) || o.now,
      author: authorOf(r, o.users),
      mine: o.mine.includes(r.user ?? "") || (Boolean(r.bot_id) && text.startsWith(BOARD_MARK)),
      bot: Boolean(r.bot_id),
      text,
    });
  }
  ch.messages.sort((a, b) => tsNum(a.id) - tsNum(b.id));
  ch.messages = ch.messages.slice(-KEEP);
  return true;
}

type Kind = Channel["kind"];
/** `id`: the conversation (a thread's channel); a thread's `ts` is its root's, `latest` its newest reply's. */
export type Kept = { key: string; name: string; kind: Kind; id: string; ts?: string; parent?: string; latest?: string };
export type KeptCopy = Kept & { after: string | null; denied: boolean; messages: SlackStored[] };
export type Conversation = { id: string; name?: string; is_im?: boolean; user?: string };
export type Member = {
  id: string;
  name?: string;
  real_name?: string;
  is_primary_owner?: boolean;
  profile?: { display_name?: string };
};
export const slackKey = (kind: Kind, id: string): string =>
  `s${kind === "dm" ? "dm" : kind === "thread" ? "t" : "c"}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
export const snippet = (t: string): string => (t.split("\n")[0] ?? "").replace(/\*/g, "").slice(0, 40) || "스레드";
