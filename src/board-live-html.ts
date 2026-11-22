import { type BotLive, LIVE_WORD, type LiveState, type LiveStatus } from "./board-live.ts";
import { avatar } from "./board-mission-html.ts";
import { ago, esc } from "./board-thread-html.ts";

/** The 지금 tab: a row per bot, the work's title on its own line so a phone shows it whole. */
export const LIVE_STYLE = `.lvt{display:block;font-size:14px;overflow-wrap:anywhere}.lv .rs.sub{font-size:12px}
.l-working{background:color-mix(in srgb,var(--blue) 20%,transparent);color:var(--blue)}.l-done{background:color-mix(in srgb,var(--green) 20%,transparent);color:var(--green)}
.l-failed{background:color-mix(in srgb,var(--red) 20%,transparent);color:var(--red)}.l-idle{background:var(--on);color:var(--muted)}
.l-unsure{background:color-mix(in srgb,var(--needs) 18%,transparent);color:var(--needs);border:1px dashed}.l-unknown{background:color-mix(in srgb,var(--needs) 18%,transparent);color:var(--needs)}`;

const ORDER: LiveStatus[] = ["working", "done", "failed", "unsure", "unknown", "idle"];
const WHEN: Record<LiveStatus, string> = {
  working: "시작",
  done: "완료",
  failed: "실패",
  unsure: "끝남",
  idle: "완료",
  unknown: "",
};

function when(b: BotLive, now: number): string {
  if (b.at === null) return "기록 없음";
  return b.status === "unknown" ? `마지막 기록 ${ago(now, b.at)}` : `${ago(now, b.at)} ${WHEN[b.status]}`;
}

function liveRow(b: BotLive, imgs: Record<string, string>, now: number): string {
  const id = `bot:${b.name}`;
  const img = imgs[id];
  const face = avatar(img ? { id, label: b.label, sub: "", img } : { id, label: b.label, sub: "" });
  const task = b.task ?? (b.status === "idle" ? "맡은 일 없음" : "기록 없음");
  const more = b.running > 1 ? ` 외 ${b.running - 1}건` : "";
  return `<div class="row lv" data-bot="${esc(b.name)}" data-status="${b.status}">${face}<span class="rb">
<span class="rt"><b>${esc(b.label)}</b><span class="ast l-${b.status}">${esc(b.word)}</span></span>
<span class="lvt">${esc(task)}${more}</span><span class="rs sub">${esc(b.machine)}${b.basis ? ` · ${esc(b.basis)}` : ""} · ${when(b, now)}</span></span></div>`;
}

/** The tab's body: how many bots are in each state, then the bots, at work first. `data-live` makes board.js reload it. */
export function liveTab(live: LiveState | null, imgs: Record<string, string>, now: number): string {
  if (!live?.bots.length) return `<p class="note" data-live>agents.json에 봇이 없어요.</p>`;
  const counts = ORDER.map((s) => [s, live.bots.filter((b) => b.status === s).length] as const).filter(([, n]) => n);
  const head = `<p class="agsum" data-live>${counts.map(([s, n]) => `${LIVE_WORD[s]} ${n}`).join(" · ")}</p>`;
  const bots = [...live.bots].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.at ?? 0) - (a.at ?? 0),
  );
  const foot = `<p class="note">dori delegate의 시작·끝 기록과 봇 게이트웨이의 Slack·Discord 세션 기록(1분마다 읽음)으로 판단해요. 30초마다 저절로 새로 읽어요.</p>`;
  return `${head}${bots.map((b) => liveRow(b, imgs, now)).join("")}${foot}`;
}
