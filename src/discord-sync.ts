import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscordAnswer, DiscordCall } from "./discord-api.ts";
import { projectAliases } from "./board-projects.ts";
import { everyoneSees, type GuildChannel, type GuildRole } from "./discord-perms.ts";
import { nameOf, type Raw, maskText } from "./discord-text.ts";
import { listThreads } from "./discord-threads.ts";

/**
 * The board's copy of the Discord server's text channels, their threads and the operator's DMs. One timer tick makes
 * at most one call: the channel list is re-read every DISCOVER_MS, otherwise the next channel in turn is asked only for
 * the messages after the newest one it already has. Page loads and polls read this copy and never call Discord. A view
 * names a channel by its key (a hash of its id), never its id, and message text has ids, webhook URLs and mentions
 * masked. A server or DM that cannot be listed is skipped (its copy kept) and named in `skipped`; the rest still syncs.
 * A thread names its parent channel by key; `project` is the ~/.dori/projects.json alias given to its id.
 */
export type DiscordMessage = { at: number; author: string; mine: boolean; bot: boolean; text: string };
type Kind = "channel" | "dm" | "thread";
/** A thread's parent channel: its key in a view, its id in the copy. */
type Threaded = { parent?: string; private?: boolean; archived?: boolean };
export type DiscordChannel = Threaded & {
  key: string;
  name: string;
  kind: Kind;
  project?: string;
  messages: DiscordMessage[];
};
export type DiscordView = {
  channels: DiscordChannel[];
  syncedAt: number | null;
  error: string | null;
  skipped: string[];
};
export type SendResult = "sent" | "failed";
export type DiscordBoard = {
  view(): DiscordView;
  /** Grows when the copy changes; the board's version hash includes it so open pages reload. */
  stamp(): number;
  send(key: string, text: string): Promise<SendResult>;
};

type Stored = DiscordMessage & { id: string };
type Kept = Threaded & {
  key: string;
  name: string;
  kind: Kind;
  id: string;
  /** The guild (`guild:<id>`) or DM recipient (`dm:<id>`) it was listed under; a failed listing keeps that scope's copy. */
  scope?: string;
  after: string | null;
  denied: boolean;
  messages: Stored[];
};

export const TICK_MS = 4_000;
const DISCOVER_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const KEEP = 100;
const PAGE = 50;
export const SEND_MAX = 1_900;

const later = (a: string, b: string): boolean => BigInt(a) > BigInt(b);
/** A channel's key: a hash of its id, so it does not move with list order or a rename and never shows the id. */
export const keyOf = (kind: Kind, id: string): string =>
  `${kind === "dm" ? "dm" : kind === "thread" ? "t" : "c"}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
const good = (a: DiscordAnswer): boolean => a.status >= 200 && a.status < 300;
const shape = (cs: Kept[]): string =>
  JSON.stringify(cs.map((c) => [c.id, c.name, c.key, c.kind, c.denied, c.parent, c.private, c.archived]));

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
  // A cache written with name keys moves to id keys; its messages and read cursors stay.
  const moved = channels.some((c) => c.key !== keyOf(c.kind, c.id));
  channels = channels.map((c) => ({ ...c, key: keyOf(c.kind, c.id) }));
  let discoveredAt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let cursor = 0;
  let version = 0;
  let busy = false;
  let syncedAt: number | null = null;
  let error: string | null = null;
  let skipped: string[] = [];

  const save = (): void => {
    version++;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ channels }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  if (moved) save();
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
    const failed: string[] = [];
    /** A 429 ends the listing (every call would wait); any other failure skips only this server or DM. */
    const skip = (what: string, a: DiscordAnswer, scope: string): boolean => {
      if (a.status === 429) return ok(a);
      failed.push(`${what} (Discord ${a.status})`);
      log(`DISCORD_SKIP ${what} ${a.status}`);
      found.push(...channels.filter((c) => c.scope === scope));
      return true;
    };
    const guilds = await call("/users/@me/guilds");
    if (!ok(guilds)) return;
    for (const g of guilds.body as { id: string }[]) {
      const scope = `guild:${g.id}`;
      const roles = await call(`/guilds/${g.id}/roles`);
      const list = good(roles) ? await call(`/guilds/${g.id}/channels`) : roles;
      if (!good(list)) {
        if (skip("서버", list, scope)) continue;
        return;
      }
      const text = (list.body as GuildChannel[])
        .filter((c) => (c.type === 0 || c.type === 5) && everyoneSees(c, g.id, roles.body as GuildRole[]))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      for (const c of text) found.push({ id: c.id, name: c.name, kind: "channel", scope });
      const ids = text.map((c) => c.id);
      const t = await listThreads(call, g.id, ids);
      if (t.limited) return void ok(t.limited);
      if (t.failed) log(`DISCORD_SKIP 스레드 ${t.failed.status}`);
      const kept = channels.filter((c) => c.scope === scope && c.kind === "thread");
      found.push(...(t.failed ? kept : t.threads.map((x) => ({ ...x, kind: "thread" as const, scope }))));
    }
    for (const user of o.users) {
      const scope = `dm:${user}`;
      const dm = await call("/users/@me/channels", { method: "POST", body: { recipient_id: user } });
      if (!good(dm)) {
        if (skip("DM", dm, scope)) continue;
        return;
      }
      const b = dm.body as { id: string; recipients?: { username?: string; global_name?: string | null }[] };
      found.push({ id: b.id, name: nameOf(b.recipients?.[0]), kind: "dm", scope });
    }
    const before = shape(channels);
    channels = found.map((f) => {
      const old = channels.find((c) => c.id === f.id);
      const key = keyOf(f.kind, f.id);
      return { ...f, key, after: old?.after ?? null, denied: false, messages: old?.messages ?? [] };
    });
    skipped = failed;
    error = null;
    if (shape(channels) !== before) save();
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
    if (!ch || o.now() < pausedUntil) return "failed";
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

  const view = (): DiscordView => {
    const alias = projectAliases(home);
    const keys = new Map(channels.map((c) => [c.id, c.key]));
    const shown = (c: Kept): DiscordChannel => {
      const parent = keys.get(c.parent ?? "");
      const project = alias.get(c.id);
      return {
        key: c.key,
        name: c.name,
        kind: c.kind,
        ...(parent ? { parent, private: c.private === true, archived: c.archived === true } : {}),
        ...(project ? { project } : {}),
        messages: c.messages.map(({ id: _, ...m }) => m),
      };
    };
    return { channels: channels.filter((c) => !c.denied).map(shown), syncedAt, error, skipped };
  };
  return { tick, send, view, stamp: () => version };
}
