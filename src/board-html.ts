import type { Ask } from "./asks.ts";
import type { BoardState, BotCard, ProjectGroup, ProjectLane } from "./board-state.ts";

export const REQUEST_MAX = 2000;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function ago(now: number, at: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

const STATUS: Record<string, [string, string]> = {
  working: ["작업 중", "blue"],
  waiting: ["답 기다림", "amber"],
  ready: ["PR 준비됨", "green"],
  lost: ["끊김", "red"],
  done: ["완료", "muted"],
  open: ["대기", "muted"],
  running: ["실행 중", "blue"],
};
const tag = (status: string): string => {
  const [label, color] = STATUS[status] ?? [status, "muted"];
  return `<span class="tag" style="--c:var(--${color})">${label}</span>`;
};

/** A form that posts to the board; without a write token it is shown disabled, so a read-only viewer sees why. */
const form = (action: string, token: string | null, body: string): string =>
  `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${esc(token ?? "")}">` +
  `<fieldset${token ? "" : " disabled"}>${body}</fieldset></form>`;

function askCard(a: Ask, now: number, token: string | null): string {
  const rec = a.options.find((o) => o.key === a.recommend);
  const options = a.options
    .map(
      (o) =>
        `<li>${o.key === a.recommend ? `<b>${esc(o.key)}. ${esc(o.text)} (추천)</b>` : `${esc(o.key)}. ${esc(o.text)}`}</li>`,
    )
    .join("");
  const buttons =
    (rec ? `<button class="primary" name="choice" value="${esc(rec.key)}">추천대로 (${esc(rec.key)})</button>` : "") +
    a.options.map((o) => `<button name="choice" value="${esc(o.key)}">${esc(o.key)}</button>`).join("");
  const sent = a.sent ? `<p class="sent">보냄: ${esc(a.sent.choice)} · ${ago(now, a.sent.at)}</p>` : "";
  const link = a.link ? `<p><a href="${esc(a.link)}" rel="noopener" target="_blank">자세히 보기</a></p>` : "";
  return `<article class="card ask" style="--c:var(--violet)">
<p class="q">${esc(a.question)}</p><ol class="opts">${options}</ol>${link}
${form("/decide", token, `<input type="hidden" name="id" value="${esc(a.id)}"><div class="buttons">${buttons}</div>`)}
${sent}<p class="meta">${esc(a.id)} · ${ago(now, a.createdAt)}</p></article>`;
}

const laneRow = (l: ProjectLane, now: number): string =>
  `<li>${tag(l.status)} <b>${esc(l.key)}</b> <span class="meta">${ago(now, l.at)}</span>` +
  (l.first ? `<br><span class="first">${esc(l.first)}</span>` : "") +
  (l.full.trim() && l.full.trim() !== l.first
    ? `<details><summary>보고 원문</summary><pre>${esc(l.full)}</pre></details>`
    : "") +
  "</li>";

function botCard(b: BotCard): string {
  const none = `<span class="none">기록 없음</span>`;
  const last = b.lastDelegate
    ? `${esc(b.lastDelegate.at.slice(5, 16).replace("T", " "))}Z ${esc(b.lastDelegate.outcome)} · ${esc(b.lastDelegate.summary) || "출력 없음"}`
    : none;
  return `<article class="card bot"><p><b>${esc(b.label)}</b> <span class="meta">${esc(b.name)} · ${esc(b.role)}</span></p>
<dl><dt>오늘 배정</dt><dd>${b.today ? esc(b.today) : none}</dd><dt>결과</dt><dd>${b.result ? esc(b.result) : none}</dd>
<dt>마지막 delegate</dt><dd>${last}</dd></dl></article>`;
}

function projectBlock(g: ProjectGroup, now: number): string {
  const count = g.lanes.length + g.backlog.length;
  const backlog = g.backlog
    .map(
      (i) =>
        `<li>${tag(i.status)} <span class="meta">p${i.priority}</span> ${esc(i.title)}` +
        (i.decision ? `<br><span class="warn">결정 필요: ${esc(i.decision)}</span>` : "") +
        "</li>",
    )
    .join("");
  const part = (title: string, html: string): string => (html ? `<h3>${title}</h3><ul class="rows">${html}</ul>` : "");
  return `<details class="project"${count ? " open" : ""}><summary><b>${esc(g.name)}</b> <span class="meta">진행 ${g.lanes.length} · 백로그 ${g.backlog.length} · 완료 ${g.done.length}</span></summary>
${part("lane", g.lanes.map((l) => laneRow(l, now)).join(""))}${part("백로그", backlog)}${part("최근 24시간 완료", g.done.map((l) => laneRow(l, now)).join(""))}</details>`;
}

const STYLE = `:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#6b7280;--line:#e5e7eb;
--blue:#2563eb;--green:#16a34a;--amber:#b45309;--red:#dc2626;--violet:#7c3aed}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--card:#1b1e24;--text:#e7e9ee;--muted:#9aa1ad;--line:#2a2f37;
--blue:#60a5fa;--green:#4ade80;--amber:#fbbf24;--red:#f87171;--violet:#a78bfa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;-webkit-text-size-adjust:100%}
main{max-width:720px;margin:0 auto;padding:max(12px,env(safe-area-inset-top)) 12px 48px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}h1{font-size:21px;margin:4px 0}
h2{font-size:17px;margin:22px 0 8px}h3{font-size:14px;margin:10px 0 4px;color:var(--muted)}
.meta{color:var(--muted);font-size:13px}.none{color:var(--muted)}.warn{color:var(--amber)}
a{color:var(--blue)}.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c,var(--line));
border-radius:12px;padding:12px;margin:0 0 10px;overflow-wrap:anywhere}.q{font-weight:600;margin:0 0 6px}
.opts{margin:0 0 8px;padding-left:20px}fieldset{border:0;margin:0;padding:0;min-width:0}
.buttons{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;min-height:44px;min-width:56px;padding:8px 14px;border-radius:10px;
border:1px solid var(--line);background:var(--bg);color:var(--text)}button.primary{background:var(--violet);border-color:var(--violet);color:#fff;font-weight:600}
fieldset:disabled button,fieldset:disabled textarea{opacity:.5}.sent{color:var(--green);font-weight:600;margin:8px 0 0}
textarea{width:100%;min-height:96px;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text)}
.flash{background:var(--green);color:#fff;border-radius:10px;padding:10px 12px;margin:10px 0}.flash.bad{background:var(--red)}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:0 7px;border-radius:6px;color:var(--c);
background:color-mix(in srgb,var(--c) 15%,transparent)}dl{margin:6px 0 0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:14px}
dt{color:var(--muted)}dd{margin:0}.rows{list-style:none;margin:0;padding:0}.rows li{padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.first{color:var(--text)}details summary{cursor:pointer;min-height:32px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.45 ui-monospace,monospace;color:var(--muted)}
.project{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 10px}
.bots{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}.bots .card{margin:0}`;

const FLASH: Record<string, string> = {
  decide: "결정을 lead에게 보냈어요.",
  request: "요청을 lead에게 보냈어요. 답은 Discord로 와요.",
  queued: "lead가 일하는 중이라 수신함에 넣었어요. 손이 비면 바로 전달돼요.",
  held: "전달이 확인되지 않았어요. 다시 누르지 말고 lead 화면을 확인해 주세요(dori inbox list lead).",
};

/** The phone board page. `token` is the write token of the signed-in operator, or null for a read-only viewer. */
export function boardHtml(s: BoardState, o: { token: string | null; flash?: string }): string {
  const now = s.generatedAt;
  const flash =
    o.flash && FLASH[o.flash] ? `<p class="flash${o.flash === "held" ? " bad" : ""}">${FLASH[o.flash]}</p>` : "";
  const readOnly = o.token ? "" : `<p class="meta">읽기 전용: 테일넷 로그인(허용된 계정)으로 열어야 버튼이 켜져요.</p>`;
  const attention = s.attention.length
    ? `<h3>확인할 lane</h3><ul class="rows card">${s.attention.map((l) => laneRow(l, now)).join("")}</ul>`
    : "";
  const asks = s.asks.length
    ? s.asks.map((a) => askCard(a, now, o.token)).join("")
    : `<p class="none">lead가 물어본 결정이 없어요.</p>`;
  const bots = s.bots.length ? s.bots.map(botCard).join("") : `<p class="none">agents.json에 봇이 없어요.</p>`;
  const projects = s.projects.length
    ? s.projects.map((g) => projectBlock(g, now)).join("")
    : `<p class="none">lane도 백로그도 없어요.</p>`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111317" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="도리 보드">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon-192.png"><title>도리 보드</title><style>${STYLE}</style></head><body><main>
<header><h1>도리 보드</h1><a class="meta" href="/">${new Date(now + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ")} KST · 새로고침</a></header>
${flash}${readOnly}
<h2>🙋 재일 님 차례 <span class="meta">${s.asks.length}건</span></h2>${asks}${attention}
<h2>✍️ 요청 보내기</h2>${form("/request", o.token, `<textarea name="text" maxlength="${REQUEST_MAX}" required placeholder="lead에게 시킬 일을 적어 주세요. 답은 Discord로 와요."></textarea><div class="buttons"><button class="primary">보내기</button></div>`)}
<h2>🤖 봇</h2><div class="bots">${bots}</div>
<h2>📁 프로젝트</h2>${projects}
</main></body></html>
`;
}
