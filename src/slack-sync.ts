import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectAliases } from "./board-projects.ts";
import type { Channel, ChannelCopy, ChannelView, SendResult } from "./channel-source.ts";
import type { SlackAnswer, SlackCall, SlackReply } from "./slack-api.ts";
import type { Conversation, KeptCopy, Member, SlackRaw } from "./slack-text.ts";
import { BOARD_MARK, maskSlack, mergeSlack, slackKey, snippet, tsNum } from "./slack-text.ts";

/**
 * The board's copy of the Slack channels the bot is in, their recent threads and the operator's DMs with the bot, like
 * discord-sync.ts: a listing tick (every DISCOVER_MS) asks for the operator's users, every user's name and the bot's
 * conversations; every other tick makes one call, the next channel's newest PAGE messages (which also says which
 * threads got replies) or the next thread with a reply newer than its copy. A 429 pauses every call for its
 * Retry-After. Page loads read this copy and never call Slack. A view names a conversation by key (a hash of its id),
 * never its id; message text has ids, tokens and webhook URLs masked. A conversation Slack no longer lets the bot read
 * is left out until the next listing finds it again.
 */
type Kind = Channel["kind"];

const DISCOVER_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const PAGE = 50;
const THREADS_PER_CHANNEL = 8;
const USER_PAGES = 5;
const GONE = new Set(["not_in_channel", "channel_not_found", "missing_scope", "is_archived", "access_denied"]);

const shape = (cs: KeptCopy[]): string => JSON.stringify(cs.map((c) => [c.key, c.name, c.denied, c.latest]));

export function slackSync(
  home: string,
  call: SlackCall,
  reply: SlackReply,
  o: { now: () => number; log?: (l: string) => void },
): ChannelCopy & { tick(): Promise<void> } {
  const path = join(home, "board", "slack-cache.json");
  const log = o.log ?? (() => {});
  let chans: KeptCopy[] = [];
  let users = new Map<string, string>();
  let mine: string[] = [];
  try {
    if (existsSync(path)) {
      const c = JSON.parse(readFileSync(path, "utf8")) as { channels?: KeptCopy[]; users?: [string, string][] };
      chans = c.channels ?? [];
      users = new Map(c.users ?? []);
    }
  } catch {
    chans = []; // a cut-off cache is rebuilt from Slack on the first tick
  }
  let discoveredAt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let cursor = 0;
  let version = 0;
  let busy = false;
  let syncedAt: number | null = null;
  let error: string | null = null;
  let alias = projectAliases(home);

  const save = (): void => {
    version++;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ channels: chans, users: [...users] }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  /** The body of a good answer; null after a 429 (every call pauses) or any failure (named in `error`). */
  const body = <T>(a: SlackAnswer): (T & { ok: true }) | null => {
    if (a.status === 429) {
      pausedUntil = o.now() + Math.max(1, a.retryAfter) * 1000;
      error = "Slack 429";
      return null;
    }
    const b = a.body as { ok?: boolean; error?: string } | null;
    if (a.status >= 200 && a.status < 300 && b?.ok) return b as T & { ok: true };
    error = `Slack ${b?.error ?? a.status}`;
    return null;
  };
  const merge = (ch: KeptCopy, raws: SlackRaw[], advance: boolean): boolean =>
    mergeSlack(ch, raws, advance, { users, mine, now: o.now() });

  async function discover(): Promise<void> {
    discoveredAt = o.now();
    alias = projectAliases(home);
    const me = body<{ users: string[] }>(await call("dori.users"));
    if (!me) return;
    const names = new Map<string, string>();
    const owners = new Set<string>();
    let next = "";
    for (let page = 0; page < USER_PAGES; page++) {
      const u = body<{
        members: Member[];
        response_metadata?: { next_cursor?: string };
      }>(await call("users.list", { limit: "200", ...(next ? { cursor: next } : {}) }));
      if (!u) return;
      for (const m of u.members) names.set(m.id, m.profile?.display_name || m.real_name || m.name || "알 수 없음");
      for (const m of u.members) if (m.is_primary_owner) owners.add(m.id);
      next = u.response_metadata?.next_cursor ?? "";
      if (!next) break;
    }
    users = names;
    // SLACK_ALLOWED_USERS may name coworkers too: the operator is the one who owns the workspace, if one does.
    mine = me.users.some((id) => owners.has(id)) ? me.users.filter((id) => owners.has(id)) : me.users;
    const list = body<{ channels: Conversation[] }>(
      await call("users.conversations", {
        types: "public_channel,private_channel,im",
        exclude_archived: "true",
        limit: "200",
      }),
    );
    if (!list) return;
    const found: KeptCopy[] = [];
    for (const c of list.channels) {
      if (c.is_im && !mine.includes(c.user ?? "")) continue;
      const kind: Kind = c.is_im ? "dm" : "channel";
      const old = chans.find((x) => x.id === c.id && x.kind === kind);
      const name = c.is_im ? (users.get(c.user ?? "") ?? "알 수 없음") : (c.name ?? "채널");
      found.push({
        ...(old ?? { after: null, messages: [] }),
        key: slackKey(kind, c.id),
        name,
        kind,
        id: c.id,
        denied: false,
      });
    }
    found.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "channel" ? -1 : 1));
    const parents = new Set(found.map((c) => c.key));
    const threads = chans.filter((t) => t.kind === "thread" && parents.has(t.parent ?? ""));
    const before = shape(chans);
    chans = [...found, ...threads];
    error = null;
    if (shape(chans) !== before) save();
  }

  /** A channel's newest messages; its roots with replies become (or refresh) its threads, the newest few kept. */
  async function pollChannel(ch: KeptCopy): Promise<void> {
    const a = await call("conversations.history", { channel: ch.id, limit: String(PAGE) });
    const err = (a.body as { error?: string } | null)?.error ?? "";
    if (GONE.has(err)) {
      ch.denied = true;
      log(`SLACK_DENIED ${ch.key} ${err}`);
      return;
    }
    const b = body<{ messages: SlackRaw[] }>(a);
    if (!b) return;
    error = null;
    const roots = b.messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts);
    let changed = merge(ch, roots, true);
    const before = shape(chans);
    for (const r of roots.filter((m) => (m.reply_count ?? 0) > 0)) {
      const key = slackKey("thread", `${ch.id}/${r.ts}`);
      const t = chans.find((x) => x.key === key);
      if (t) t.latest = r.latest_reply ?? r.ts;
      else
        chans.push({
          key,
          name: snippet(maskSlack(r, users)),
          kind: "thread",
          id: ch.id,
          ts: r.ts,
          parent: ch.key,
          latest: r.latest_reply ?? r.ts,
          after: null,
          denied: false,
          messages: [],
        });
    }
    const mineT = chans
      .filter((t) => t.parent === ch.key)
      .sort((x, y) => tsNum(y.latest ?? "") - tsNum(x.latest ?? ""));
    const drop = new Set(mineT.slice(THREADS_PER_CHANNEL).map((t) => t.key));
    chans = chans.filter((c) => !drop.has(c.key));
    if (shape(chans) !== before) changed = true;
    if (changed) save();
  }

  async function pollThread(t: KeptCopy): Promise<void> {
    const b = body<{ messages: SlackRaw[] }>(
      await call("conversations.replies", {
        channel: t.id,
        ts: t.ts ?? "",
        limit: "100",
        ...(t.after ? { oldest: t.after } : {}),
      }),
    );
    if (!b) return;
    error = null;
    if (merge(t, b.messages, true)) save();
  }

  async function tick(): Promise<void> {
    if (busy || o.now() < pausedUntil) return;
    busy = true;
    try {
      if (o.now() - discoveredAt > (chans.length && mine.length ? DISCOVER_MS : RETRY_MS)) await discover();
      else {
        const due = chans.filter(
          (c) => !c.denied && (c.kind !== "thread" || c.after === null || tsNum(c.latest ?? "") > tsNum(c.after)),
        );
        const ch = due.length ? due[cursor++ % due.length]! : undefined;
        if (ch) await (ch.kind === "thread" ? pollThread(ch) : pollChannel(ch));
      }
      if (!error) syncedAt = o.now();
    } catch (e) {
      error = `Slack 연결 실패 (${e instanceof Error ? e.name : "error"})`;
    } finally {
      busy = false;
    }
  }

  async function send(key: string, text: string): Promise<SendResult> {
    const ch = chans.find((c) => c.key === key && !c.denied);
    if (!ch || o.now() < pausedUntil) return "failed";
    const said = `${BOARD_MARK} ${text}`;
    try {
      const ts = await reply(ch.id, ch.ts ?? "", said);
      if (!ts) return "failed";
      if (merge(ch, [{ ts, text: said, bot_id: "board" }], false)) save();
      return "sent";
    } catch {
      return "failed";
    }
  }

  const view = (): ChannelView => {
    const shown = (c: KeptCopy): Channel => {
      const project = c.kind === "thread" ? undefined : alias.get(c.id);
      return {
        key: c.key,
        name: c.name,
        kind: c.kind,
        ...(c.parent ? { parent: c.parent, archived: false, locked: false } : {}),
        ...(project ? { project } : {}),
        messages: c.messages.map(({ id: _, ...m }) => m),
      };
    };
    const threads = chans
      .filter((c) => c.kind === "thread" && !c.denied)
      .sort((a, b) => tsNum(b.latest ?? "") - tsNum(a.latest ?? ""));
    const live = chans.filter((c) => c.kind !== "thread" && !c.denied);
    return { channels: [...live, ...threads].map(shown), syncedAt, error, skipped: [] };
  };
  return { tick, send, view, stamp: () => version };
}
