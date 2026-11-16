/** A Discord message as the API returns it, the text of it a board page may show, and the copy's kept messages. */
export type DiscordMessage = { at: number; author: string; mine: boolean; bot: boolean; text: string };
type Stored = DiscordMessage & { id: string };
export type Raw = {
  id: string;
  content?: string;
  timestamp?: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
  mentions?: { id: string; username?: string; global_name?: string | null }[];
  attachments?: { filename?: string }[];
  embeds?: { title?: string; description?: string }[];
};

const TEXT_MAX = 4_000;
const KEEP = 100;
const later = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export const nameOf = (u: { username?: string; global_name?: string | null } | undefined): string =>
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

/**
 * Adds the messages a channel does not have yet, newest KEEP kept; true when any was added. A message the board sent
 * must not move the read cursor (`advance`): messages posted before it would be skipped.
 */
export function mergeMessages(
  ch: { after: string | null; messages: Stored[] },
  raws: Raw[],
  advance: boolean,
  o: { names: Map<string, string>; users: string[]; now: number },
): boolean {
  const have = new Set(ch.messages.map((m) => m.id));
  const fresh = raws.filter((r) => typeof r.id === "string" && !have.has(r.id));
  for (const r of raws) if (advance && (ch.after === null || later(r.id, ch.after))) ch.after = r.id;
  if (!fresh.length) return false;
  for (const r of fresh)
    ch.messages.push({
      id: r.id,
      at: Date.parse(r.timestamp ?? "") || o.now,
      author: nameOf(r.author),
      mine: o.users.includes(r.author?.id ?? ""),
      bot: r.author?.bot === true,
      text: maskText(r, o.names),
    });
  ch.messages.sort((a, b) => (later(a.id, b.id) ? 1 : -1));
  ch.messages = ch.messages.slice(-KEEP);
  return true;
}
