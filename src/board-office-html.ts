import { type BotLive, LIVE_WORD, type LiveState, type LiveStatus } from "./board-live.ts";
import { avatar, hue } from "./board-mission-html.ts";
import { esc } from "./board-thread-html.ts";

/**
 * The 사무실 tab: the 지금 tab's LiveState drawn as a 2D pixel office, one room per machine and one desk per bot in
 * agents.json order, so a bot keeps its seat. No state of its own: each bot's look follows its LiveStatus. Everything is
 * drawn here (CSS and inline SVG; the head is the board's avatar) and moves only by CSS animation, still under
 * prefers-reduced-motion.
 */
export type Pose = "typing" | "sit" | "rest";
export type Mark = "bubble" | "check" | "bang" | "ask" | null;
/** How one bot looks: its pose, what floats over its head (`say`) and the line under its name tag. */
export type Look = { pose: Pose; mark: Mark; dim: boolean; say: string; caption: string };
export type Zone = { machine: string; label: string; bots: BotLive[] };

const ORDER: LiveStatus[] = ["working", "done", "failed", "unknown", "idle"];
/** The time of day in KST, as the board's header shows it. */
const hhmm = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(11, 16);

export function officeLook(b: BotLive): Look {
  const one = (pose: Pose, mark: Mark, say: string, caption: string, dim = false): Look => ({
    pose,
    mark,
    dim,
    say,
    caption,
  });
  if (b.status === "working")
    return one("typing", "bubble", b.task ?? b.word, b.running > 1 ? `${b.word} · ${b.running}건` : b.word);
  if (b.status === "done") return one("sit", "check", "✓", b.at === null ? b.word : `${hhmm(b.at)} 끝냄`);
  if (b.status === "failed") return one("sit", "bang", "!", b.at === null ? b.word : `${b.word} · ${hhmm(b.at)}`);
  if (b.status === "idle") return one("rest", null, "", b.word);
  return one("sit", "ask", "?", b.at === null && !b.row ? "기록 없음" : b.word, true);
}

/** A room's sign: the Mac mini under any of the names its bots give it, else the machine's own name. */
const zoneLabel = (machine: string): string => (/mini|mac/i.test(machine) ? "Mac mini" : machine);

/** The bots by machine, rooms in the order their first bot appears in agents.json, seats in that order too. */
export function officeZones(bots: BotLive[]): Zone[] {
  const zones = new Map<string, Zone>();
  for (const b of bots) {
    const label = zoneLabel(b.machine);
    const z = zones.get(label) ?? { machine: b.machine, label, bots: [] };
    z.bots.push(b);
    zones.set(label, z);
  }
  return [...zones.values()];
}

const SVG = `xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true"`;
const CHAIR = `<svg class="ch" ${SVG} viewBox="0 0 16 20"><rect x="1" y="0" width="14" height="13" class="c1"/><rect x="2" y="1" width="12" height="11" class="c2"/><rect x="7" y="13" width="2" height="5" class="c1"/><rect x="3" y="18" width="10" height="2" class="c1"/></svg>`;
const DESK = `<svg class="dk" ${SVG} viewBox="0 0 48 24"><rect x="2" y="0" width="15" height="10" class="m1"/><rect x="3" y="1" width="13" height="8" class="scr"/><rect x="4" y="2" width="6" height="1" class="ln"/><rect x="4" y="4" width="9" height="1" class="ln"/><rect x="4" y="6" width="4" height="1" class="ln"/>
<rect x="8" y="10" width="3" height="1" class="m1"/><rect x="20" y="10" width="11" height="1" class="m1"/><rect x="38" y="7" width="4" height="4" class="mug"/><rect x="42" y="8" width="1" height="2" class="mug"/>
<rect x="0" y="11" width="48" height="3" class="d1"/><rect x="1" y="14" width="46" height="10" class="d2"/><rect x="3" y="16" width="18" height="6" class="d1"/><rect x="27" y="16" width="18" height="6" class="d1"/><rect x="11" y="18" width="2" height="1" class="d3"/><rect x="35" y="18" width="2" height="1" class="d3"/></svg>`;

export const OFFICE_STYLE = `.of{display:flex;flex-direction:column;gap:12px;margin:0 2px}.room{border:3px solid var(--line);background:repeating-conic-gradient(var(--fl1) 0 25%,var(--fl2) 0 50%) 0 0/16px 16px;min-width:0}
.of{--fl1:#1d2a2e;--fl2:#19252a;--wall:#2a3a40;--wood:#8a5a35;--wood2:#6b4426;--wood3:#d9b26a;--mon:#3a4549;--seat:#3d4f8f;--seat2:#5468b0}
@media (prefers-color-scheme:light){.of{--fl1:#e9e2d4;--fl2:#e1d8c6;--wall:#cfc4ad;--wood:#b07a4a;--wood2:#8d5c33;--wood3:#f0d08a;--mon:#4b5559;--seat:#5a6cb8;--seat2:#7d8fd6}}
.wall{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--wall);padding:5px 9px;border-bottom:3px solid var(--line);font-size:13px}.wall b{background:var(--panel);padding:1px 8px;border:2px solid var(--line);font-size:13px}.wall span{color:var(--muted);font-size:12px}
.desks{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px 6px;padding:8px 6px 10px}
.seat{display:flex;flex-direction:column;align-items:center;min-width:0;color:var(--text);padding:2px;border:2px solid transparent}.seat:hover,.seat:focus-visible{border-color:var(--link);outline:none}
.say{position:relative;height:36px;max-width:100%;display:flex;align-items:flex-end}.say i{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font:600 11.5px/1.3 inherit;font-style:normal;background:var(--panel);color:var(--text);border:2px solid var(--text);padding:1px 5px;overflow-wrap:anywhere;text-align:center;box-shadow:2px 2px 0 var(--line)}
.say i::after{content:"";position:absolute;bottom:-4px;left:58%;width:6px;height:6px;background:var(--text)}.m-check i,.m-bang i,.m-ask i{font-size:15px;line-height:1.1;padding:1px 7px}
.m-check i{background:var(--green);border-color:var(--green);color:#06210f}.m-check i::after{background:var(--green)}.m-bang i{background:var(--red);border-color:var(--red);color:#fff}.m-bang i::after{background:var(--red)}
.m-ask i{border-style:dashed}.say:empty{visibility:hidden}
.spot{position:relative;width:92px;height:70px;max-width:100%}.dk{position:absolute;left:0;bottom:0;width:92px;height:46px}.ch{position:absolute;left:48px;bottom:14px;width:30px;height:38px}
.c1{fill:var(--seat)}.c2{fill:var(--seat2)}.m1{fill:var(--mon)}.scr{fill:#0c1416}.ln{fill:transparent}.d1{fill:var(--wood)}.d2{fill:var(--wood2)}.d3{fill:var(--wood3)}.mug{fill:transparent}
.who{position:absolute;left:50px;bottom:20px;width:26px;display:flex;flex-direction:column;align-items:center;transform-origin:50% 100%}
.who .av.hd{width:24px;height:24px;border-radius:3px;font-size:12px;image-rendering:pixelated;border:2px solid #0d1214;position:relative;z-index:1}
.bd{width:26px;height:20px;margin-top:-2px;background:hsl(var(--h) 45% 48%);border:2px solid #0d1214;border-bottom:0}
.arm{position:absolute;bottom:2px;width:7px;height:6px;background:hsl(var(--h) 45% 40%);border:2px solid #0d1214;z-index:2}.arm.l{left:-5px}.arm.r{right:-5px}
.zz{position:absolute;left:76px;top:2px;font:700 12px/1 monospace;color:var(--muted)}
.o-working .scr{fill:color-mix(in srgb,var(--blue) 55%,#0c1416)}.o-working .ln{fill:#d7e8ff;animation:scr 1.2s steps(2) infinite}
.o-working .arm{bottom:-6px;animation:tp .5s steps(2) infinite}.o-working .arm.r{animation-delay:.25s}
.o-done .scr{fill:color-mix(in srgb,var(--green) 45%,#0c1416)}.o-failed .scr{fill:color-mix(in srgb,var(--red) 55%,#0c1416)}
.o-idle .who{transform:rotate(-7deg) translateY(2px)}.o-idle .mug{fill:#e8e1d2}.o-idle .zz{animation:zz 2.4s steps(4) infinite}
.o-unknown .spot,.o-unknown .tag,.o-unknown .say{opacity:.42;filter:grayscale(1)}
.tag{margin-top:3px;max-width:100%;font-size:13px;background:var(--panel);border:2px solid var(--line);padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cap{max-width:100%;font-size:11.5px;color:var(--muted);text-align:center;overflow-wrap:anywhere}.o-working .cap{color:var(--blue)}.o-done .cap{color:var(--green)}.o-failed .cap{color:var(--red)}
@keyframes tp{50%{transform:translateY(-3px)}}@keyframes scr{50%{opacity:.25}}@keyframes zz{0%{transform:translate(0,4px);opacity:0}50%{opacity:1}100%{transform:translate(4px,-6px);opacity:0}}
@media (prefers-reduced-motion:reduce){.of *,.of *::before,.of *::after{animation:none!important}}`;

function seat(b: BotLive, imgs: Record<string, string>): string {
  const id = b.row ?? `bot:${b.name}`;
  const href = b.row ? `/?c=${encodeURIComponent(b.row)}` : `/?c=bot:${encodeURIComponent(b.name)}`;
  const img = imgs[id];
  const look = officeLook(b);
  const face = avatar(img ? { id, label: b.label, sub: "", img } : { id, label: b.label, sub: "" }, "hd");
  const about = `${b.label}${b.role ? ` (${b.role})` : ""} · ${b.word}${b.task ? ` · ${b.task}` : ""}`;
  const say = look.say ? `<i>${esc(look.say)}</i>` : "";
  return `<a class="seat o-${b.status}" href="${href}" data-bot="${esc(b.name)}" data-look="${look.pose}" title="${esc(about)}" aria-label="${esc(about)}">
<span class="say${look.mark ? ` m-${look.mark}` : ""}">${say}</span><span class="spot">${CHAIR}<span class="who" style="--h:${hue(id)}">${face}<span class="bd"></span><span class="arm l"></span><span class="arm r"></span></span>${DESK}${look.pose === "rest" ? '<span class="zz">z</span>' : ""}</span>
<b class="tag">${esc(b.label)}</b><span class="cap">${esc(look.caption)}</span></a>`;
}

/** The tab's body: the counts as on the 지금 tab, then a room per machine. `data-live` makes board.js reload it. */
export function officeTab(live: LiveState | null, imgs: Record<string, string>): string {
  if (!live?.bots.length) return `<p class="note" data-live>agents.json에 봇이 없어요.</p>`;
  const counts = ORDER.map((s) => [s, live.bots.filter((b) => b.status === s).length] as const).filter(([, n]) => n);
  const head = `<p class="agsum" data-live>${counts.map(([s, n]) => `${LIVE_WORD[s]} ${n}`).join(" · ")}</p>`;
  const rooms = officeZones(live.bots)
    .map(
      (z) =>
        `<section class="room" data-machine="${esc(z.label)}"><header class="wall"><b>${esc(z.label)}</b><span>${z.bots.some((b) => b.row) ? "lead · " : ""}봇 ${z.bots.filter((b) => !b.row).length}</span></header>` +
        `<div class="desks">${z.bots.map((b) => seat(b, imgs)).join("")}</div></section>`,
    )
    .join("");
  const foot = `<p class="note">자리를 누르면 그 봇과의 대화로 가요. '지금' 탭과 같은 기록으로 판단하고 30초마다 저절로 새로 읽어요.</p>`;
  return `${head}<div class="of">${rooms}</div>${foot}`;
}
