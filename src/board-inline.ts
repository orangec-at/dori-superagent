import { readAsk } from "./asks.ts";
import { readCoupas } from "./board-coupas.ts";
import { coupasCard } from "./board-coupas-html.ts";
import { flashNote } from "./board-html.ts";
import { askCard } from "./board-thread-html.ts";

/**
 * board.js sends an answer button (확인 필요 POST /decide, 쿠파스 POST /coupas) in the background with Accept:
 * application/json. Such a request passed the same writer, origin and CSRF checks as a form; it gets the card's new
 * state instead of a redirect, so the page keeps its scroll and what is open. A form posted without the script (no
 * JSON in Accept) gets the redirect as before.
 */
export const wantsCard = (req: Request): boolean => (req.headers.get("accept") ?? "").includes("application/json");

/** `card`: the card's new html, null when it stays as it was (held, failed, gone). `v`: the page version now. */
type CardReply = { card: string | null; note: string; bad: boolean; v: string };

const reply = (r: CardReply, headers: Record<string, string>): Response => Response.json(r, { headers });

/** The answer to a background /decide: the ask's card as marked now, unless nothing was marked (held, failed). */
export function decideReply(
  home: string,
  id: string,
  flash: string,
  o: { now: number; token: string; v: string; headers: Record<string, string> },
): Response {
  const ask = flash === "held" || flash === "failed" ? undefined : readAsk(home, id);
  const card = ask?.status === "open" ? askCard(ask, o.now, o.token) : null;
  return reply({ card, ...flashNote(flash), v: o.v }, o.headers);
}

/** The answer to a background /coupas the board accepted: the post's card with what posted.json says now. */
export function coupasReply(
  home: string,
  id: string,
  o: { token: string; v: string; headers: Record<string, string> },
): Response {
  return reply({ card: coupasCard(readCoupas(home), id, o.token), ...flashNote("coupas"), v: o.v }, o.headers);
}
