import type { DiscordAnswer, DiscordCall } from "./discord-api.ts";

/**
 * The threads of a server's copied text channels, for the board to show under their parent. Only public and
 * announcement threads: a private thread is seen by its invitees alone, and the board copies only what @everyone sees.
 * A listing reads the server's active threads in one call, then each parent's newest archived threads. The newest by
 * last message come first: active threads up to THREAD_MAX, archived ones only up to
 * ARCHIVED_MAX, so old threads never bury the channels.
 */
export type FoundThread = {
  id: string;
  name: string;
  parent: string;
  archived: boolean;
  locked: boolean;
  last: string;
};
type RawThread = {
  id: string;
  name?: string;
  type?: number;
  parent_id?: string | null;
  last_message_id?: string | null;
  thread_metadata?: { archived?: boolean; locked?: boolean };
};

const PUBLIC_THREADS = new Set([10, 11]);
const ARCHIVED_PER_PARENT = 5;
export const ARCHIVED_MAX = 10;
const THREAD_MAX = 30;

const good = (a: DiscordAnswer): boolean => a.status >= 200 && a.status < 300;
const threadsOf = (a: DiscordAnswer, parents: string[], archived: boolean): FoundThread[] =>
  ((a.body as { threads?: RawThread[] } | null)?.threads ?? [])
    .filter((t) => PUBLIC_THREADS.has(t.type ?? -1) && parents.includes(t.parent_id ?? ""))
    .map((t) => ({
      id: t.id,
      name: t.name ?? "스레드",
      parent: t.parent_id ?? "",
      archived,
      locked: t.thread_metadata?.locked === true,
      last: t.last_message_id ?? t.id,
    }));

/** The guild's active threads under `parents` (ids of copied channels), or null with the failed answer. */
export async function activeThreads(
  call: DiscordCall,
  guild: string,
  parents: string[],
): Promise<{ threads: FoundThread[] | null; answer: DiscordAnswer }> {
  const a = await call(`/guilds/${guild}/threads/active`);
  return { threads: good(a) ? threadsOf(a, parents, false) : null, answer: a };
}

export async function archivedThreads(call: DiscordCall, parent: string): Promise<FoundThread[] | DiscordAnswer> {
  const a = await call(`/channels/${parent}/threads/archived/public?limit=${ARCHIVED_PER_PARENT}`);
  return good(a) ? threadsOf(a, [parent], true) : a;
}

type Copied = { id: string; kind: string; parent?: string; archived?: boolean; last?: string };
const newest = (a: Copied, b: Copied): number => (BigInt(b.last ?? "0") > BigInt(a.last ?? "0") ? 1 : -1);

/** The copy with its threads capped: channels and DMs in order, then active threads, then archived, each newest first. */
export function capThreads<T extends Copied>(cs: T[]): T[] {
  const threads = cs.filter((c) => c.kind === "thread").sort(newest);
  const live = threads.filter((t) => !t.archived).slice(0, THREAD_MAX);
  const old = threads.filter((t) => t.archived).slice(0, Math.min(ARCHIVED_MAX, THREAD_MAX - live.length));
  return [...cs.filter((c) => c.kind !== "thread"), ...live, ...old];
}
