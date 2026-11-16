import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscordAnswer, DiscordCall } from "./discord-api.ts";

/**
 * The board's copy of the Discord server's text channels and the operator's DMs. One timer tick makes at most one
 * call: the channel list is re-read every DISCOVER_MS, otherwise the next channel in turn is asked only for the
 * messages after the newest one it already has. Page loads and polls read this copy and never call Discord. A view
 * names a channel by its key (its name), never its id, and message text has ids, webhook URLs and mentions masked.
 */
export type DiscordMessage = { at: number; author: string; mine: boolean; bot: boolean; text: string };
export type DiscordChannel = { key: string; name: string; kind: "channel" | "dm"; messages: DiscordMessage[] };
export type DiscordView = { channels: DiscordChannel[]; syncedAt: number | null; error: string | null };
export type SendResult = "sent" | "failed";
export type DiscordBoard = {
  view(): DiscordView;
  /** Grows when the copy changes; the board's version hash includes it so open pages reload. */
  stamp(): number;
  send(key: string, text: string): Promise<SendResult>;
};

type Stored = DiscordMessage & { id: string };
type Kept = {
  key: string;
  name: string;
  kind: "channel" | "dm";
  id: string;
  after: string | null;
  denied: boolean;
  messages: Stored[];
};
type Raw = {
  id: string;
  content?: string;
  timestamp?: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
  mentions?: { id: string; username?: string; global_name?: string | null }[];
  attachments?: { filename?: string }[];
  embeds?: { title?: string; description?: string }[];
};

export const TICK_MS = 4_000;
const DISCOVER_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const KEEP = 100;
const PAGE = 50;
const TEXT_MAX = 4_000;
export const SEND_MAX = 1_900;

const later = (a: string, b: string): boolean => BigInt(a) > BigInt(b);
const nameOf = (u: { username?: string; global_name?: string | null } | undefined): string =>
  u?.global_name || u?.username || "알 수 없음";

/** Message text a page may show: mentions as names, custom emoji as :name:, every id-like number and webhook masked. */
export function maskText(m: Raw, channelNames: Map<string, string>): string {
  const users = new Map((m.mentions ?? []).map((u) => [u.id, nameOf(u)]));
  let t = m.content ?? "";
  for (const a of m.attachments ?? []) t += `\n[첨부] ${a.filename ?? "파일"}`;
  for (const e of m.embeds ?? [])
    if (e.title || e.description) t += `\n[카드] ${[e.title, e.description].filter(Boolean).join(" · ")}`;
  return t
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${users.get(id) ?? "누군가"}`)
    .replace(/<@&\d+>/g, "@역할")
    .replace(/<#(\d+)>/g, (_, id: string) => `#${channelNames.get(id) ?? "채널"}`)
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/https?:\/\/\S*discord(?:app)?\.com\/api\/webhooks\/\S+/gi, "(webhook)")
    .replace(/\b\d{17,20}\b/g, "(ID)")
    .trim()
    .slice(0, TEXT_MAX);
}

export function discordSync(
  home: string,
  call: DiscordCall,
  o: { now: () => number; users: string[]; log?: (l: string) => void },
): DiscordBoard & { tick(): Promise<void> } {
  const path = join(home, "board", "discord-cache.json");
  const log = o.log ?? (() => {});
  let channels: Kept[] = [];
  try {
    if (existsSync(path)) channels = (JSON.parse(readFileSync(path, "utf8")) as { channels: Kept[] }).channels ?? [];
  } catch {
    channels = []; // a cut-off cache is rebuilt from Discord on the first tick
  }
  let discoveredAt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let cursor = 0;
  let version = 0;
  let busy = false;
  let syncedAt: number | null = null;
  let error: string | null = null;

  const save = (): void => {
    version++;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ channels }));
    renameSync(`${path}.tmp`, path);
  };
  const ok = (a: DiscordAnswer): boolean => {
    if (a.status === 429) pausedUntil = o.now() + Math.max(1, a.retryAfter) * 1000;
    if (a.status >= 200 && a.status < 300) return true;
    error = `Discord ${a.status}`;
    return false;
  };
  const names = (): Map<string, string> => new Map(channels.map((c) => [c.id, c.name]));

  /** A message the board sent must not move the read cursor (`advance`): messages posted before it would be skipped. */
  function merge(ch: Kept, raws: Raw[], advance: boolean): boolean {
    const have = new Set(ch.messages.map((m) => m.id));
    const fresh = raws.filter((r) => typeof r.id === "string" && !have.has(r.id));
    for (const r of raws) if (advance && (ch.after === null || later(r.id, ch.after))) ch.after = r.id;
    if (!fresh.length) return false;
    const n = names();
    for (const r of fresh)
      ch.messages.push({
        id: r.id,
        at: Date.parse(r.timestamp ?? "") || o.now(),
        author: nameOf(r.author),
        mine: o.users.includes(r.author?.id ?? ""),
        bot: r.author?.bot === true,
        text: maskText(r, n),
      });
    ch.messages.sort((a, b) => (later(a.id, b.id) ? 1 : -1));
    ch.messages = ch.messages.slice(-KEEP);
    return true;
  }

  async function discover(): Promise<void> {
    discoveredAt = o.now();
    const found: Omit<Kept, "key" | "after" | "denied" | "messages">[] = [];
    const guilds = await call("/users/@me/guilds");
    if (!ok(guilds)) return;
    for (const g of guilds.body as { id: string }[]) {
      const list = await call(`/guilds/${g.id}/channels`);
      if (!ok(list)) return;
      const text = (list.body as { id: string; name: string; type: number; position?: number }[])
        .filter((c) => c.type === 0 || c.type === 5)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      for (const c of text) found.push({ id: c.id, name: c.name, kind: "channel" });
    }
    for (const user of o.users) {
      const dm = await call("/users/@me/channels", { method: "POST", body: { recipient_id: user } });
      if (!ok(dm)) return;
      const b = dm.body as { id: string; recipients?: { username?: string; global_name?: string | null }[] };
      found.push({ id: b.id, name: nameOf(b.recipients?.[0]), kind: "dm" });
    }
    const keys = new Set<string>();
    channels = found.map((f) => {
      const old = channels.find((c) => c.id === f.id);
      let key = f.kind === "dm" ? `dm-${f.name}` : f.name;
      while (keys.has(key)) key += "_";
      keys.add(key);
      return { ...f, key, after: old?.after ?? null, denied: false, messages: old?.messages ?? [] };
    });
    error = null;
    save();
  }

  async function poll(ch: Kept): Promise<void> {
    const a = await call(`/channels/${ch.id}/messages?limit=${PAGE}${ch.after ? `&after=${ch.after}` : ""}`);
    if (a.status === 403 || a.status === 404) {
      ch.denied = true;
      log(`DISCORD_DENIED ${ch.key} ${a.status}`);
      return;
    }
    if (!ok(a)) return;
    error = null;
    if (merge(ch, a.body as Raw[], true)) save();
  }

  async function tick(): Promise<void> {
    if (busy || o.now() < pausedUntil) return;
    busy = true;
    try {
      if (o.now() - discoveredAt > (channels.length ? DISCOVER_MS : RETRY_MS)) await discover();
      else {
        const live = channels.filter((c) => !c.denied);
        if (live.length) await poll(live[cursor++ % live.length]!);
      }
      if (!error) syncedAt = o.now();
    } catch (e) {
      error = `Discord 연결 실패 (${e instanceof Error ? e.name : "error"})`;
    } finally {
      busy = false;
    }
  }

  async function send(key: string, text: string): Promise<SendResult> {
    const ch = channels.find((c) => c.key === key && !c.denied);
    if (!ch) return "failed";
    try {
      const body = { content: `**재일 (보드)** ${text}`.slice(0, 2000), allowed_mentions: { parse: [] } };
      const a = await call(`/channels/${ch.id}/messages`, { method: "POST", body });
      if (!ok(a)) return "failed";
      if (merge(ch, [a.body as Raw], false)) save();
      return "sent";
    } catch {
      return "failed";
    }
  }

  const view = (): DiscordView => ({
    channels: channels
      .filter((c) => !c.denied)
      .map((c) => ({ key: c.key, name: c.name, kind: c.kind, messages: c.messages.map(({ id: _, ...m }) => m) })),
    syncedAt,
    error,
  });
  return { tick, send, view, stamp: () => version };
}
