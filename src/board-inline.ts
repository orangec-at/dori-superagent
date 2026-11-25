import { readAsk } from "./asks.ts";
import { readCoupas } from "./board-coupas.ts";
import { coupasCard } from "./board-coupas-html.ts";
import { flashNote } from "./board-html.ts";
import { boardState } from "./board-state.ts";
import { projectTasks } from "./board-tasks.ts";
import { taskCard } from "./board-tasks-html.ts";
import { askCard } from "./board-thread-html.ts";
import type { Store } from "./store.ts";

/**
 * board.js sends an answer button (확인 필요 POST /decide, 쿠파스 POST /coupas, a task's buttons on 할 일 POST /backlog)
 * in the background with Accept:
 * application/json. Such a request passed the same writer, origin and CSRF checks as a form; it gets the card's new
 * state instead of a redirect, so the page keeps its scroll and what is open. A form posted without the script (no
 * JSON in Accept) gets the redirect as before.
 */
export const wantsCard = (req: Request): boolean => (req.headers.get("accept") ?? "").includes("application/json");

/**
 * `seen`: the version the page sent was the board's version just before this write. `fresh`: the version now. Only
 * then may the page take the version after its write; otherwise something else changed too and the page says so.
 */
type Inline = { now: number; token: string; headers: Record<string, string>; seen: boolean; fresh: () => string };

/**
 * `card`: the card's new html, null when it stays as it was (held, failed). `gone`: the ask or post is no longer open,
 * so its buttons go. `held`: the delivery may have reached the lead, so the buttons stay off (pressing again would send
 * it twice). `v`: the version the page shows now, null when another change came before this write.
 */
type CardReply = { card: string | null; gone: boolean; held: boolean; note: string; bad: boolean; v: string | null };

const reply = (card: string | null, gone: boolean, flash: string, o: Inline): Response =>
  Response.json(
    { card, gone, held: flash === "held", ...flashNote(flash), v: o.seen ? o.fresh() : null } satisfies CardReply,
    {
      headers: o.headers,
    },
  );

/** The answer to a background /decide: the ask's card as marked now, unless nothing was marked (held, failed). */
export function decideReply(home: string, id: string, flash: string, o: Inline): Response {
  if (flash === "held" || flash === "failed") return reply(null, false, flash, o);
  const ask = readAsk(home, id);
  return ask?.status === "open" ? reply(askCard(ask, o.now, o.token), false, flash, o) : reply(null, true, flash, o);
}

/** The answer to a background /coupas the board accepted: the post's card with what posted.json says now. */
export function coupasReply(home: string, id: string, o: Inline): Response {
  const card = coupasCard(readCoupas(home), id, o.token);
  return reply(card, card === null, "coupas", o);
}

/**
 * The answer to a background /backlog edit the board accepted: the task's card as the project's 할 일 shows it now, in
 * place; its column, order and the chip counts catch up at the next reload. A drop takes the buttons away; a card not
 * found otherwise (another project's `p`) keeps them.
 */
export function backlogReply(store: Store, form: URLSearchParams, o: Inline): Response {
  const s = boardState(store, o.now);
  const g = s.projects.find((x) => x.name === form.get("p"));
  const t = g && projectTasks(g, s.bots, o.now).find((x) => x.id === form.get("id"));
  const card = g && t ? taskCard(t, g.name, o.token, o.now) : null;
  return reply(card, card === null && form.get("action") === "drop", "backlog", o);
}
