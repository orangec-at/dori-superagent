import type { ProjectGroup } from "./board-state.ts";
import { esc, mark } from "./board-thread-html.ts";

/** The 백로그 tab: each project's open backlog items, a pending decision marked as the operator's turn. */
export function backlogTab(projects: ProjectGroup[]): string {
  const html = projects
    .filter((g) => g.backlog.length)
    .map(
      (g) =>
        `<h3 class="sec"><span>${esc(g.name)} <span>${g.backlog.length}</span></span></h3>` +
        g.backlog
          .map(
            (i) =>
              `<div class="row">${mark({ section: i.decision ? "needs" : "idle", health: "idle" })}<span class="rb"><span class="rt"><b>${esc(i.title)}</b></span>` +
              `<span class="rs"><span class="proj">p${i.priority}</span> <span class="w">${esc(i.status)}</span>${i.decision ? ` · 결정 필요: ${esc(i.decision)}` : ""}</span></span></div>`,
          )
          .join(""),
    )
    .join("");
  return html || `<p class="note">열린 백로그가 없어요.</p>`;
}
