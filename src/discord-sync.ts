import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectAliases } from "./board-projects.ts";
import type { DiscordAnswer, DiscordCall } from "./discord-api.ts";
import { everyoneSees, type GuildChannel, type GuildRole } from "./discord-perms.ts";
import { type DiscordMessage, mergeMessages, nameOf, type Raw } from "./discord-text.ts";
import { activeThreads, archivedThreads, capThreads, type FoundThread } from "./discord-threads.ts";

export type { DiscordMessage } from "./discord-text.ts";

/**
 * The board's copy of the Discord server's text channels, their public threads and the operator's DMs. A listing tick
 * (every DISCOVER_MS) calls once per server for its roles, channels and active threads, once per copied channel for
 * its archived threads (a 429 there stops only those, keeping the archived threads already copied), and once per DM;
 * every other tick makes one call, asking the next channel or thread in turn only for the messages after the newest one
 * it has (an archived thread is read once: it changes only when reopened, and the next listing then finds it active). Page loads and polls read this copy and never call Discord. A
 * view names a channel by its key (a hash of its id), never its id, and message text has ids, webhook URLs and mentions
 * masked. A server, DM or thread listing that fails is skipped (its copy kept) and named in `skipped`; the rest still
 * syncs. A thread names its parent channel by key; `project` is the ~/.dori/projects.json alias for its id, read at
 * each listing.
 */
type Kind = "channel" | "dm" | "thread";
export type DiscordChannel = {
  key: string;
  name: string;
  kind: Kind;
  parent?: string;
  archived?: boolean;
  locked?: boolean;
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

type Kept = Omit<Partial<FoundThread>, "id" | "name"> & {
  key: string;
  name: string;
  kind: Kind;
  id: string;
  /** The guild (`guild:<id>`) or DM recipient (`dm:<id>`) it was listed under; a failed listing keeps that scope's copy. */
  scope?: string;
  after: string | null;
  denied: boolean;
  messages: (DiscordMessage & { id: string })[];
};
type Found = Omit<Kept, "key" | "after" | "denied" | "messages">;

export const TICK_MS = 4_000;
const DISCOVER_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const PAGE = 50;
export const SEND_MAX = 1_900;

/** A channel's key: a hash of its id, so it does not move with list order or a rename and never shows the id. */
export const keyOf = (kind: Kind, id: string): string =>
  `${kind === "dm" ? "dm" : kind === "thread" ? "t" : "c"}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
const good = (a: DiscordAnswer): boolean => a.status >= 200 && a.status < 300;
const shape = (cs: Kept[]): string =>
  JSON.stringify(cs.map((c) => [c.id, c.name, c.key, c.kind, c.denied, c.parent, c.archived, c.locked]));

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
  let alias = projectAliases(home);

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
  const merge = (ch: Kept, raws: Raw[], advance: boolean): boolean =>
    mergeMessages(ch, raws, advance, { names: names(), users: o.users, now: o.now() });
  /** A listed channel, DM or thread, keeping the messages and read cursor its copy already has. */
  const kept = (f: Found): Kept => {
    const old = channels.find((c) => c.id === f.id);
    return { ...f, key: keyOf(f.kind, f.id), after: old?.after ?? null, denied: false, messages: old?.messages ?? [] };
  };

  async function discover(): Promise<void> {
    discoveredAt = o.now();
    alias = projectAliases(home);
    const found: Found[] = [];
    const failed: string[] = [];
    let limited = false;
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
      const t = await activeThreads(call, g.id, ids);
      if (t.answer.status === 429) return void ok(t.answer);
      // A failed listing keeps the threads already copied: all of them, or that channel's archived ones.
      const old = channels.filter((c) => c.scope === scope && c.kind === "thread" && ids.includes(c.parent ?? ""));
      if (!t.threads) {
        skip("스레드", t.answer, `${scope}:none`);
        found.push(...old);
        continue;
      }
      const live = new Set(t.threads.map((x) => x.id));
      for (const id of ids) {
        const a: FoundThread[] | DiscordAnswer | null = limited ? null : await archivedThreads(call, id);
        if (a && !Array.isArray(a) && a.status === 429) limited = !ok(a);
        const got = Array.isArray(a) ? a : old.filter((c) => c.archived && c.parent === id);
        found.push(...got.filter((x) => !live.has(x.id)).map((x) => ({ ...x, kind: "thread" as const, scope })));
      }
      found.push(...t.threads.map((x) => ({ ...x, kind: "thread" as const, scope })));
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
    channels = capThreads(found.map(kept));
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
        const live = channels.filter((c) => !c.denied && !(c.archived && c.after !== null));
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
    const ch = channels.find((c) => c.key === key && !c.denied && !c.locked);
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
    const keys = new Map(channels.map((c) => [c.id, c.key]));
    // A thread whose parent is no longer copied has no row to sit under; it is left out.
    const shown = (c: Kept): DiscordChannel | [] => {
      const parent = keys.get(c.parent ?? "");
      if (c.kind === "thread" && !parent) return [];
      const project = alias.get(c.id);
      return {
        key: c.key,
        name: c.name,
        kind: c.kind,
        ...(parent ? { parent, archived: c.archived === true, locked: c.locked === true } : {}),
        ...(project ? { project } : {}),
        messages: c.messages.map(({ id: _, ...m }) => m),
      };
    };
    return { channels: channels.filter((c) => !c.denied).flatMap(shown), syncedAt, error, skipped };
  };
  return { tick, send, view, stamp: () => version };
}
