import type { Ask } from "./asks.ts";
import { byPerson } from "./board-asks.ts";
import { askCard } from "./board-thread-html.ts";

/**
 * The 확인 필요 tab: every open ask grouped by who answers it. jaeil's cards keep the board's answer buttons (POST
 * /decide, as in the lead's record); bokyung's are read only, answered on Slack and closed by the lead.
 */
export function asksTab(checks: Ask[], now: number, token: string | null): string {
  const groups = byPerson(checks).map(({ who, label, asks }) => {
    const note =
      who === "jaeil"
        ? ""
        : `<p class="note">${label} 항목은 보드에서 답하지 않아요. Slack으로 답을 받고 도리도라가 닫아요.</p>`;
    const cards = asks.length
      ? asks.map((a) => askCard(a, now, token, who === "jaeil")).join("")
      : `<p class="note">지금은 ${label} 확인이 필요한 항목이 없어요.</p>`;
    return `<section class="asks" id="for-${who}"><h3 class="sec"><span class="needs">${label} <span>${asks.length}</span></span></h3>${note}${cards}</section>`;
  });
  return groups.join("");
}
