import { type AgentActivity, STALE_MS, STATE_WORD } from "./board-agents.ts";
import { avatar } from "./board-mission-html.ts";
import { ago, esc } from "./board-thread-html.ts";

/** The 에이전트 tab: a row per agent that unfolds to its details; activity a day old or older is dimmed. */
export const AGENTS_STYLE = `.ag{border-radius:10px}.ag>summary{list-style:none;cursor:pointer}.ag>summary::-webkit-details-marker{display:none}
.ag[open]>summary{background:var(--on)}.ag.old>summary{opacity:.5}.ag .rs.sub{font-size:12px}
.ast{font-size:11.5px;font-weight:700;padding:0 8px;border-radius:999px;white-space:nowrap}.a-working{background:color-mix(in srgb,var(--blue) 20%,transparent);color:var(--blue)}
.a-waiting{background:var(--on);color:var(--muted)}.a-silent{background:color-mix(in srgb,var(--red) 20%,transparent);color:var(--red)}.a-none{background:var(--on);color:var(--idle)}
.agd{margin:2px 10px 10px 46px;font-size:13px;display:flex;flex-direction:column;gap:3px;overflow-wrap:anywhere}.agd p{margin:0;white-space:pre-wrap}
.agd .lks{display:flex;flex-wrap:wrap;gap:4px 10px}.agsum{padding:0 10px 4px;font-size:13px;color:var(--muted)}`;

const GROUPS: [AgentActivity["kind"][], string][] = [
  [["lead"], "리드"],
  [["lane"], "lane"],
  [["bot"], "봇"],
  [["muse"], "외부 협업"],
];
const DETAIL_MAX = 600;

const clip = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s);

function agentRow(a: AgentActivity, imgs: Record<string, string>, now: number): string {
  const img = imgs[a.id];
  const face = avatar(img ? { id: a.id, label: a.name, sub: "", img } : { id: a.id, label: a.name, sub: "" });
  const old = a.at !== null && now - a.at >= STALE_MS;
  const pill = a.state
    ? `<span class="ast a-${a.state}">${STATE_WORD[a.state]}</span>`
    : `<span class="ast a-none">기록 없음</span>`;
  const links = a.links.length
    ? `<span class="lks">${a.links.map((l) => `<a href="${esc(l.href)}" rel="noopener" target="_blank">${esc(l.label)}</a>`).join("")}</span>`
    : "";
  const open = a.href ? `<a href="${esc(a.href)}">기록 열기 →</a>` : "";
  return `<details class="ag${old ? " old" : ""}" data-agent="${esc(a.id)}"><summary class="row">${face}<span class="rb">
<span class="rt"><b>${esc(a.name)}</b>${pill}<span class="ago">${a.at === null ? "기록 없음" : ago(now, a.at)}</span></span>
<span class="rs">${esc(a.line ?? "기록 없음")}</span><span class="rs sub">${esc(a.sub)}</span></span></summary>
<div class="agd">${a.detail.map((d) => `<p>${esc(clip(d))}</p>`).join("")}${links}${open}</div></details>`;
}

/** The tab's body: how many agents are at work or silent, then the agents by kind. */
export function agentsTab(agents: AgentActivity[], imgs: Record<string, string>, now: number): string {
  const count = (s: AgentActivity["state"]): number => agents.filter((a) => a.state === s).length;
  const head = `<p class="agsum">작업 중 ${count("working")} · 대기 ${count("waiting")} · 응답 없음 ${count("silent")}</p>`;
  const body = GROUPS.map(([kinds, label]) => {
    const list = agents.filter((a) => kinds.includes(a.kind));
    if (!list.length) return "";
    return `<h3 class="sec"><span>${label} <span>${list.length}</span></span></h3>${list.map((a) => agentRow(a, imgs, now)).join("")}`;
  }).join("");
  return `${head}${body}`;
}
