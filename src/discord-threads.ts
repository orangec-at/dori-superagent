import type { DiscordAnswer, DiscordCall } from "./discord-api.ts";

/**
 * The threads of a server's copied text channels, for the board to show under their parent. One listing reads the
 * server's active threads (public and private ones the bot can see), then each parent's archived public threads and,
 * while the bot may (Manage Threads), its archived private ones. The newest by last message come first: every active
 * thread up to THREAD_MAX, archived ones only up to ARCHIVED_MAX, so old threads never bury the channels.
 */
export type FoundThread = { id: string; name: string; parent: string; private: boolean; archived: boolean };
type RawThread = {
  id: string;
  name?: string;
  type?: number;
  parent_id?: string | null;
  last_message_id?: string | null;
  thread_metadata?: { archived?: boolean };
};

const THREAD_TYPES = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;
export const ARCHIVED_PER_PARENT = 5;
export const ARCHIVED_MAX = 10;
export const THREAD_MAX = 30;

const good = (a: DiscordAnswer): boolean => a.status >= 200 && a.status < 300;
const threadsIn = (a: DiscordAnswer): RawThread[] => (a.body as { threads?: RawThread[] } | null)?.threads ?? [];
const activity = (t: RawThread): bigint => BigInt(t.last_message_id ?? t.id);

/**
 * The guild's threads under `parents` (ids of channels already copied), or a 429 answer that ends the listing. `failed`
 * is the active listing's failure (the caller keeps that server's threads); an archived listing that fails adds none.
 */
export async function listThreads(
  call: DiscordCall,
  guild: string,
  parents: string[],
): Promise<{ threads: FoundThread[]; failed: DiscordAnswer | null; limited: DiscordAnswer | null }> {
  const active = await call(`/guilds/${guild}/threads/active`);
  if (active.status === 429) return { threads: [], failed: null, limited: active };
  if (!good(active)) return { threads: [], failed: active, limited: null };
  const raws = threadsIn(active).map((t) => ({ ...t, thread_metadata: { ...t.thread_metadata, archived: false } }));
  let privateOk = true;
  for (const parent of parents) {
    for (const kind of privateOk ? ["public", "private"] : ["public"]) {
      const a = await call(`/channels/${parent}/threads/archived/${kind}?limit=${ARCHIVED_PER_PARENT}`);
      if (a.status === 429) return { threads: [], failed: null, limited: a };
      if (kind === "private" && (a.status === 403 || a.status === 401)) privateOk = false;
      if (good(a))
        raws.push(...threadsIn(a).map((t) => ({ ...t, thread_metadata: { ...t.thread_metadata, archived: true } })));
    }
  }
  const allowed = new Set(parents);
  const seen = new Set<string>();
  const fresh = raws
    .filter(
      (t) => THREAD_TYPES.has(t.type ?? -1) && allowed.has(t.parent_id ?? "") && !seen.has(t.id) && seen.add(t.id),
    )
    .sort((a, b) => (activity(b) > activity(a) ? 1 : activity(b) < activity(a) ? -1 : 0));
  const live = fresh.filter((t) => !t.thread_metadata?.archived);
  const old = fresh.filter((t) => t.thread_metadata?.archived).slice(0, ARCHIVED_MAX);
  const keep = new Set([...live, ...old].slice(0, THREAD_MAX).map((t) => t.id));
  return {
    threads: fresh
      .filter((t) => keep.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name ?? "스레드",
        parent: t.parent_id ?? "",
        private: t.type === PRIVATE_THREAD,
        archived: t.thread_metadata?.archived === true,
      })),
    failed: null,
    limited: null,
  };
}
