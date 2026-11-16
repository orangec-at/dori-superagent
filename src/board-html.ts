import { AGENTS_STYLE } from "./board-agents-html.ts";
import type { LinksRead } from "./board-links-file.ts";
import { LINKS_STYLE, linksPane } from "./board-links-html.ts";
import { hrefOf, listPane, type View } from "./board-list-html.ts";
import { DETAIL_STYLE, detailPane, missionDetail, rowFace } from "./board-detail-html.ts";
import { MISSION_STYLE, missionCard, missionPane } from "./board-mission-html.ts";
import { channelPane, PROJECTS_STYLE, projectPane, projectsList } from "./board-projects-html.ts";
import type { BoardState } from "./board-state.ts";
import type { Thread } from "./board-thread.ts";
import { esc, form, record } from "./board-thread-html.ts";
import type { DiscordView } from "./discord-sync.ts";

export const REQUEST_MAX = 2000;

const STYLE = `:root{color-scheme:dark light;--bg:#12181a;--list:#0f1517;--panel:#182226;--bubble:#222d31;--text:#e6ecec;--muted:#8a9a9d;
--line:#233034;--on:#1c282c;--needs:#f5a524;--blue:#5b9cf5;--green:#4ade80;--red:#f87171;--idle:#5d6b6e;--link:#7fb2ff}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfa;--list:#f3f4f3;--panel:#fff;--bubble:#eceeed;--text:#1b2224;--muted:#66767a;
--line:#e1e5e4;--on:#e6eae9;--needs:#b86e00;--blue:#2563eb;--green:#16a34a;--red:#dc2626;--idle:#a3adaf;--link:#1d4ed8}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--link);text-decoration:none}.meta{color:var(--muted);font-size:12px}
.app{min-height:100dvh}.list{background:var(--list);padding:max(10px,env(safe-area-inset-top)) 8px 32px}
.pane{display:flex;flex-direction:column;min-height:100dvh;min-width:0}
.has-c .list{display:none}body:not(.has-c) .pane{display:none}
.lh{display:flex;justify-content:space-between;align-items:baseline;padding:4px 10px 10px}.lh b{font-size:18px}
.tabs{display:flex;gap:4px;background:var(--panel);border-radius:12px;padding:4px;margin:0 4px 10px}
.tab{flex:1;text-align:center;padding:7px 4px;border-radius:9px;color:var(--muted);font-weight:500}.tab.on{background:var(--bg);color:var(--text)}
.chips{display:flex;gap:6px;padding:0 6px 8px;flex-wrap:wrap}.chip{padding:4px 11px;border-radius:9px;background:var(--panel);color:var(--muted);font-size:14px}
.chip.on{color:var(--text);background:var(--on)}.chip.hot{color:var(--needs);background:color-mix(in srgb,var(--needs) 16%,transparent)}
.sec{font-size:14px;font-weight:600;color:var(--muted);margin:14px 10px 2px}.sec .needs{color:var(--needs)}details.sec summary{cursor:pointer}
.row{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:10px;color:var(--text)}a.row:hover,.row.on{background:var(--on)}
.rb{min-width:0;flex:1}.rt{display:flex;gap:8px;align-items:baseline}.rt b{font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rs{display:block;color:var(--muted);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.proj{color:var(--muted)}
.ago{color:var(--muted);font-size:12px;white-space:nowrap}.pr,.repo{font-size:12.5px;color:var(--needs);white-space:nowrap}.repo{color:var(--muted);background:var(--panel);padding:0 6px;border-radius:6px}
.w.s-needs{color:var(--needs)}.w.s-unread{color:var(--green)}.w.s-working{color:var(--blue)}
.ic{flex:none;width:18px;height:18px;margin-top:2px;border-radius:50%;display:grid;place-items:center;font:700 12px/1 system-ui;color:#111}
.ic.s-needs{background:var(--needs)}.ic.h-error{background:var(--red)}.ic.s-unread{background:none}.ic.s-unread::after{content:"";width:9px;height:9px;border-radius:50%;background:var(--green)}
.ic.s-working:not(.h-error){border:2px solid var(--blue);border-right-color:transparent;animation:spin 1.4s linear infinite}
.ic.s-revisit:not(.h-error){border:2px solid var(--idle)}.ic.s-idle{background:none}.ic.s-idle::after{content:"";width:7px;height:7px;border-radius:50%;background:var(--idle)}
@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.ic{animation:none!important}}
.rec-h{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:max(10px,env(safe-area-inset-top)) 14px 10px;
background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.back{font-size:20px;padding:2px 8px 2px 0;color:var(--muted)}.title{min-width:0;flex:1}.title b{font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thread{flex:1;width:100%;max-width:800px;margin:0 auto;padding:16px 16px 8px;display:flex;flex-direction:column;gap:14px}
h3.needs{margin:0;font-size:15px;color:var(--needs)}.msg{display:flex;flex-direction:column;overflow-wrap:anywhere}.msg.me{align-items:flex-end}
.bubble{background:var(--bubble);border-radius:18px;padding:9px 14px;max-width:85%;white-space:pre-wrap}.text{white-space:pre-wrap}
.msg .meta{margin-top:3px}.meta.bad{color:var(--red)}.ev{margin:2px 0;font-size:13px;overflow-wrap:anywhere}
.work{color:var(--muted);font-size:13.5px}.work summary{cursor:pointer;list-style:none}.work summary::before{content:"›";display:inline-block;margin-right:6px;transition:transform .15s}
.work[open] summary::before{transform:rotate(90deg)}.work pre{margin:6px 0 4px 10px;padding:8px 10px;border-left:2px solid var(--line);white-space:pre-wrap;
overflow-wrap:anywhere;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.more summary{color:var(--link);cursor:pointer}
.prs summary{cursor:pointer;font-weight:600}.prs ul{margin:6px 0 0;padding-left:18px}.note{color:var(--muted);font-size:13px;margin:6px 10px}
.ask{background:color-mix(in srgb,var(--needs) 9%,var(--panel));border:1px solid color-mix(in srgb,var(--needs) 45%,transparent);border-radius:14px;padding:12px 14px}
.kicker{margin:0 0 4px;color:var(--needs);font-size:13px}.q{font-weight:600;margin:0 0 6px}.opts{margin:0 0 10px;padding-left:20px}
.opts em{color:var(--needs);font-style:normal;font-size:12px}fieldset{border:0;margin:0;padding:0;min-width:0}.buttons{display:flex;flex-wrap:wrap;gap:8px}
button{font:inherit;min-height:42px;min-width:52px;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bubble);color:var(--text);cursor:pointer}
button.primary{background:var(--needs);border-color:var(--needs);color:#1b1200;font-weight:600}fieldset:disabled button,fieldset:disabled textarea{opacity:.45}
.sent{color:var(--green);font-weight:600;margin:8px 0 0}
.flash{margin:8px 12px;border-radius:10px;padding:9px 12px;background:color-mix(in srgb,var(--green) 18%,var(--bg))}.flash.bad{background:color-mix(in srgb,var(--red) 22%,var(--bg))}
.composer{position:sticky;bottom:0;padding:8px 12px max(12px,env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 35%)}
.box{max-width:800px;margin:0 auto;display:flex;align-items:flex-end;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:7px 7px 7px 16px}
.box textarea{flex:1;min-height:42px;max-height:40vh;resize:none;border:0;outline:0;background:transparent;color:var(--text);font:inherit;padding:9px 0;field-sizing:content}
.box button{flex:none;width:40px;min-width:40px;height:40px;min-height:40px;padding:0;border-radius:50%;background:var(--needs);border-color:var(--needs);color:#1b1200;font-size:18px}
#news{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);background:var(--needs);color:#1b1200;padding:6px 14px;border-radius:999px;font-size:13px;z-index:6}
@media (min-width:768px){.app{display:grid;grid-template-columns:320px minmax(0,1fr)}.list{position:sticky;top:0;align-self:start;height:100dvh;overflow-y:auto;border-right:1px solid var(--line)}
.has-c .list{display:block}body:not(.has-c) .pane{display:flex}.back{display:none}}`;

const FLASH: Record<string, string> = {
  decide: "결정을 도리도라에게 보냈어요.",
  request: "도리도라에게 보냈어요. 답은 이 대화에 와요.",
  queued: "도리도라가 일하는 중이라 수신함에 넣었어요. 손이 비면 바로 전달돼요.",
  held: "전달이 확인되지 않았어요. 다시 누르지 말고 lead 화면을 확인해 주세요(dori inbox list lead).",
  failed: "도리도라에게 보내지 못했어요. 다시 보내 주세요.",
  discord: "Discord에 보냈어요.",
  dfailed: "Discord로 보내지 못했어요. 잠시 뒤 다시 보내 주세요.",
};
const BAD_FLASH: ReadonlySet<string> = new Set(["held", "failed", "dfailed"]);

/** `links`: the collected connection map, read only for the 연결 tab. */
export type PageOptions = {
  token: string | null;
  version: string;
  view: View;
  flash?: string;
  links?: LinksRead;
  /** The Discord copy; "locked" when the viewer may not write (a DM or channel is shown only to a writer). */
  discord?: DiscordView | "locked" | null;
};

/**
 * The board page: the row list beside (a phone: instead of) the selected row's record or mission, whose composer writes
 * to the lead.
 */
export function boardHtml(t: Thread, s: BoardState, now: number, o: PageOptions): string {
  const r = t.row;
  const mission = o.view.m ? s.missions.find((m) => m.id === o.view.m) : undefined;
  const d = o.discord === "locked" ? null : (o.discord ?? null);
  const projView = o.view.tab === "proj" && !mission && !o.view.c;
  const chan = projView && o.view.d ? d?.channels.find((c) => c.key === o.view.d) : undefined;
  const proj = projView && !chan ? s.projects.find((g) => g.name === o.view.p) : undefined;
  const open = Boolean(o.view.c || mission || chan || proj);
  const linksView = o.view.tab === "map" && !open;
  const bare = linksView || projView;
  // A message from a mission is about its row the operator acts on, else its first bot or lane: the lead sees which.
  const about = mission
    ? (mission.needs ?? mission.actors.find((a) => /^(bot|lane|standing):/.test(a.id))?.id ?? "lead")
    : r.id;
  const flash =
    o.flash && FLASH[o.flash] ? `<p class="flash${BAD_FLASH.has(o.flash) ? " bad" : ""}">${FLASH[o.flash]}</p>` : "";
  const readOnly = o.token ? "" : `<p class="note">읽기 전용이에요. 허용된 계정·기기로 열어야 보낼 수 있어요.</p>`;
  const placeholder = mission
    ? `도리도라에게 이 미션 관련 메시지…`
    : r.id === "lead"
      ? "도리도라에게 메시지…"
      : `도리도라에게 ${r.title} 관련 메시지…`;
  const composer = form(
    "/request",
    o.token,
    `<input type="hidden" name="c" value="${esc(about)}"><div class="box"><textarea name="text" rows="1" maxlength="${REQUEST_MAX}" required placeholder="${esc(placeholder)}" aria-label="메시지"></textarea><button class="send" aria-label="보내기">↑</button></div>`,
    "composer",
  );
  const kst = new Date(now + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  const back = hrefOf(o.view, { c: null, m: null });
  const card = s.cards[r.id];
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#12181a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fbfbfa" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="도리 보드"><meta name="board-version" content="${esc(o.version)}">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon-192.png"><title>도리 보드</title><style>${STYLE}${MISSION_STYLE}${DETAIL_STYLE}${LINKS_STYLE}${PROJECTS_STYLE}${AGENTS_STYLE}</style>
<script src="/board.js" defer></script></head><body${open ? ' class="has-c"' : ""}>
<div class="app${linksView ? " lk" : projView ? " pj" : ""}">${bare ? "" : `<input class="dt" id="dt" type="checkbox" aria-label="${mission ? "참여" : "미션"} 패널"><label class="dtb" for="dt">${mission ? "참여" : "미션"}</label>`}
<aside class="list" aria-label="작업 목록"><header class="lh"><b>도리 보드</b><a class="meta" href="${esc(hrefOf(o.view))}">${kst} KST</a></header>
${open ? "" : flash}${readOnly}${listPane(t.rows, { ...s, links: o.links ?? null, ...(o.view.tab === "proj" ? { proj: projectsList(s, o.discord ?? null, o.view, now) } : {}) }, o.view, now, mission || bare ? null : (o.view.c ?? "lead"))}</aside>
<main class="pane">${
    linksView
      ? linksPane(o.links ?? null, s.avatars)
      : projView
        ? `${open ? flash : ""}${chan && d ? channelPane(chan, s, d, o.token, now, back) : (proj ?? s.projects[0]) ? projectPane((proj ?? s.projects[0])!, s, d, o.view, now, back) : `<p class="note">진행 중인 프로젝트가 없어요.</p>`}`
        : `${open ? flash : ""}${mission ? missionPane(mission, now, back) : record(t, now, o.token, back, card ? missionCard(card, "inline") : "", rowFace(r, s.avatars))}
${composer}`
  }</main>${bare ? "" : `${mission ? missionDetail(mission) : detailPane(r, card, s.routines, s.missions, now, s.avatars)}<label class="dts" for="dt" aria-hidden="true"></label>`}</div><a id="news" href="${esc(hrefOf(o.view))}" hidden>새 소식이 있어요 · 눌러서 보기</a>
</body></html>
`;
}
