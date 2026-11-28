import type { Ask } from "./asks.ts";
import { askTime, byPerson, byProject, kstStamp } from "./board-asks.ts";
import { ago, askCard, esc } from "./board-thread-html.ts";

/** When the ask came in, as the KST clock and how long ago; empty when its file has no readable time. */
const when = (a: Ask, now: number): string => {
  const at = askTime(a);
  return at === undefined ? "" : `${kstStamp(at)} · ${ago(now, at)}`;
};

/**
 * The 확인 필요 tab: every open ask grouped by who answers it, then by project (see byProject), newest first. jaeil's cards keep the board's answer buttons (POST
 * /decide, as in the lead's record); bokyung's are read only, answered on Slack and closed by the lead.
 */
export function asksTab(checks: Ask[], now: number, token: string | null): string {
  const groups = byPerson(checks).map(({ who, label, asks }) => {
    const note =
      who === "jaeil"
        ? ""
        : `<p class="note">${label} 항목은 보드에서 답하지 않아요. Slack으로 답을 받고 도리도라가 닫아요.</p>`;
    const cards = asks.length
      ? byProject(asks)
          .map(
            (g) =>
              `<h4 class="proj-sec">${esc(g.project)} <span>${g.asks.length}</span></h4>` +
              g.asks.map((a) => askCard(a, now, token, who === "jaeil", when(a, now))).join(""),
          )
          .join("")
      : `<p class="note">지금은 ${label} 확인이 필요한 항목이 없어요.</p>`;
    return `<section class="asks" id="for-${who}"><h3 class="sec"><span class="needs">${label} <span>${asks.length}</span></span></h3>${note}${cards}</section>`;
  });
  return groups.join("");
}
