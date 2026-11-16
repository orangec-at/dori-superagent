/** A Discord message as the API returns it, and the text of it a board page may show. */
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
