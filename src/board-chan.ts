import { type ChannelSource, sourceOf } from "./channel-source.ts";
import { SEND_MAX } from "./discord-sync.ts";

type Reject = (code: string, why: string, status: number) => Response;

/**
 * POST /chan, reached only after the board's writer, origin and CSRF checks passed: sends the text to the channel,
 * thread or DM the form names by key, through the source whose copy lists it, and returns to that conversation on the
 * 채널 tab. A key no copy lists is refused before any messenger is called.
 */
export async function chanPost(
  sources: readonly ChannelSource[],
  form: URLSearchParams,
  o: { reject: Reject; log: (line: string) => void; headers: Record<string, string> },
): Promise<Response> {
  const key = form.get("d") ?? "";
  const said = (form.get("text") ?? "").trim();
  if (!sources.length) return o.reject("chan-off", "no messenger is connected to this board", 409);
  const found = sourceOf(sources, key);
  if (!found) return o.reject("channel", "unknown channel", 404);
  const [src, ch] = found;
  if (ch.locked) return o.reject("locked", "locked thread", 409);
  if (said === "") return o.reject("empty", "empty message", 400);
  if (said.length > SEND_MAX) return o.reject("length", `message longer than ${SEND_MAX} characters`, 413);
  const result = await src.send(key, said);
  o.log(`BOARD_CHAN ${src.id} len=${said.length} ${result}`);
  const flash = result === "sent" ? "chan" : "cfailed";
  return new Response(null, {
    status: 303,
    headers: { location: `/?tab=chan&d=${encodeURIComponent(key)}&sent=${flash}#end`, ...o.headers },
  });
}
