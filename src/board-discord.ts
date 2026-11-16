import { type DiscordBoard, SEND_MAX } from "./discord-sync.ts";

type Reject = (code: string, why: string, status: number) => Response;

/**
 * POST /discord, reached only after the board's writer, origin and CSRF checks passed: sends the text to the channel
 * or DM the form names by key and returns to that conversation. A key the copy does not list is refused before any call.
 */
export async function discordPost(
  d: DiscordBoard | undefined,
  form: URLSearchParams,
  o: { reject: Reject; log: (line: string) => void; headers: Record<string, string> },
): Promise<Response> {
  const key = form.get("d") ?? "";
  const said = (form.get("text") ?? "").trim();
  if (!d) return o.reject("discord-off", "Discord is not connected to this board", 409);
  const ch = d.view().channels.find((c) => c.key === key);
  if (!ch) return o.reject("channel", "unknown channel", 404);
  if (ch.locked) return o.reject("locked", "locked thread", 409);
  if (said === "") return o.reject("empty", "empty message", 400);
  if (said.length > SEND_MAX) return o.reject("length", `message longer than ${SEND_MAX} characters`, 413);
  const result = await d.send(key, said);
  o.log(`BOARD_DISCORD len=${said.length} ${result}`);
  const flash = result === "sent" ? "discord" : "dfailed";
  return new Response(null, {
    status: 303,
    headers: { location: `/?tab=proj&d=${encodeURIComponent(key)}&sent=${flash}#end`, ...o.headers },
  });
}
