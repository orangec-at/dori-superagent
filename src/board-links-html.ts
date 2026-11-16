import { type LinkActor, type LinkChannel, type LinkDir, type LinkSnapshot, UNKNOWN } from "./board-links.ts";
import { esc } from "./board-thread-html.ts";

/**
 * The 연결 tab. Desktop and tablet: a node-and-line map, operator -> channel -> lead -> lanes and bots grouped by
 * computer, each node with its CLI, provider and model. A phone: the same actors as cards with chips.
 */

export const LINKS_STYLE = `.lkm{overflow-x:auto;padding:4px 0 12px}.lkm svg{display:block;min-width:900px;width:100%;height:auto}
.lkm text{fill:var(--text);font-family:inherit}.lkm .mu{fill:var(--muted)}.lkm .nd{fill:var(--panel);stroke:var(--line)}
.lkm .nd.lead{stroke:var(--needs)}.lkm .ch{fill:var(--bubble);stroke:var(--line)}.lkm .gp{fill:none;stroke:var(--line);stroke-dasharray:4 4}
.lkm .e{fill:none;stroke:var(--idle);stroke-width:1.5}.lkm .e.sd{stroke-dasharray:5 4}.lkm .ar{fill:var(--idle)}.lkm .un{fill:var(--needs)}
.lkl{display:flex;flex-direction:column;gap:8px;padding:0 4px}.lkc{display:flex;gap:10px;padding:10px 12px;border-radius:14px;background:var(--panel);color:var(--text)}
.lkc .rb b{display:block;font-weight:600}.lkc .rs{white-space:normal}.lkx{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.lkx span{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--bubble);color:var(--muted)}.lkx .cl{color:var(--text)}.lkx .un{color:var(--needs)}
.lku{margin:6px 10px;padding-left:18px;color:var(--muted);font-size:13px}.thread.lkt{max-width:none}
@media (min-width:1024px){.app.lk{grid-template-columns:320px minmax(0,1fr)}}
@media (min-width:768px) and (max-width:1023px){.app.lk{grid-template-columns:minmax(0,1fr)}.app.lk .list{position:static;height:auto;overflow:visible;border-right:0;padding-bottom:0}
.app.lk .list>:not(.lh):not(.tabs){display:none}}`;

const ARROW: Record<LinkDir, string> = { both: "⇄", in: "←", out: "→" };
const KIND: Record<LinkActor["kind"], string> = {
  lead: "lead",
  duty: "당번",
  standing: "상설 lead",
  lane: "lane",
  bot: "봇",
};
const clip = (s: string, n: number): string => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s);
const modelOf = (a: LinkActor): string => `${a.model ?? UNKNOWN} · ${a.provider ?? UNKNOWN}`;
const chanText = (c: LinkChannel): string => `${ARROW[c.dir]} ${c.with} · ${c.name}`;
const kst = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const avatarName = (a: LinkActor): string | null => (a.id === "lead" ? "lead" : a.kind === "bot" ? a.id : null);
const hue = (id: string): number => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const rowHref = (a: LinkActor): string | null => (a.kind === "duty" ? null : `/?c=${encodeURIComponent(a.id)}`);

/** Computers in map order: the lead's first, then by name. */
function byComputer(actors: LinkActor[]): [string, LinkActor[]][] {
  const home = actors.find((a) => a.kind === "lead")?.computer ?? "";
  const groups = new Map<string, LinkActor[]>();
  for (const a of actors.filter((x) => x.kind === "lane" || x.kind === "bot"))
    groups.set(a.computer, [...(groups.get(a.computer) ?? []), a]);
  return [...groups].sort(([a], [b]) => (a === home ? -1 : b === home ? 1 : a.localeCompare(b)));
}

function face(a: LinkActor, imgs: Record<string, string>): string {
  const key = avatarName(a);
  const src = key ? imgs[key] : undefined;
  return src
    ? `<img class="av" src="${esc(src)}" alt="">`
    : `<span class="av" style="--h:${hue(a.id)}">${esc([...a.label][0] ?? "?")}</span>`;
}

/** The phone list (also the list column on wide screens): the operator's channels, then each actor as a card. */
export function linksList(s: LinkSnapshot | null, imgs: Record<string, string>): string {
  if (!s)
    return `<p class="note">아직 연결 정보를 모으지 않았어요. 매시 loop가 돌거나 lead가 dori agents map 을 실행하면 보여요.</p>`;
  const lead = s.actors.find((a) => a.kind === "lead");
  const card = (a: LinkActor): string => {
    const chips = [
      `<span class="cl">${esc(a.cli)}</span>`,
      `<span class="${a.provider && a.model ? "" : "un"}">${esc(modelOf(a))}</span>`,
      `<span>🖥 ${esc(a.computer)}</span>`,
      ...(a.via ? [`<span>${esc(a.via)}</span>`] : []),
      ...a.channels.map((c) => `<span>${esc(chanText(c))}</span>`),
    ].join("");
    const body = `${face(a, imgs)}<span class="rb"><b>${esc(a.label)}</b><span class="rs">${KIND[a.kind]}</span><span class="lkx">${chips}</span></span>`;
    const href = rowHref(a);
    return href ? `<a class="lkc" href="${esc(href)}">${body}</a>` : `<div class="lkc">${body}</div>`;
  };
  const top = [lead, ...s.actors.filter((a) => a.kind === "duty" || a.kind === "standing")].filter(
    (a): a is LinkActor => a !== undefined,
  );
  const groups = byComputer(s.actors)
    .map(([c, list]) => `<h3 class="sec">🖥 ${esc(c)} <span>${list.length}</span></h3>${list.map(card).join("")}`)
    .join("");
  const unknown = s.unknown.length
    ? `<h3 class="sec">알 수 없음 <span>${s.unknown.length}</span></h3><ul class="lku">${s.unknown.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
    : "";
  return `<p class="note">${kst(s.generatedAt)} KST에 모음 · 비밀값 없이 이름만 보여요</p><div class="lkl">${top.map(card).join("")}${groups}</div>${unknown}`;
}

const NODE_H = 78;
const CH_H = 40;
const X = { person: 16, chan: 196, lead: 440, work: 744 };
const WIDTH = { person: 140, chan: 196, lead: 240, work: 340 };
const SVG_W = X.work + WIDTH.work + 16;

type Box = { x: number; y: number; w: number; h: number };
const mid = (b: Box, side: "l" | "r"): [number, number] => [side === "l" ? b.x : b.x + b.w, b.y + b.h / 2];

/** A curve from a's right edge to b's left edge, with an arrowhead at each end the direction asks for. */
function edge(a: Box, b: Box, dir: LinkDir, cls = ""): string {
  const [[x1, y1], [x2, y2]] = [mid(a, "r"), mid(b, "l")];
  const c = (x1 + x2) / 2;
  const head = (x: number, y: number, toRight: boolean): string =>
    `<path class="ar" d="M${x} ${y} l${toRight ? -8 : 8} -4 v8 z"/>`;
  return `<path class="e${cls ? ` ${cls}` : ""}" d="M${x1} ${y1} C${c} ${y1} ${c} ${y2} ${x2} ${y2}"/>${dir !== "out" ? head(x2, y2, true) : ""}${dir !== "in" ? head(x1, y1, false) : ""}`;
}

function node(a: LinkActor, b: Box, imgs: Record<string, string>, i: number): string {
  const key = avatarName(a);
  const src = key ? imgs[key] : undefined;
  const [cx, cy] = [b.x + 26, b.y + 30];
  const pic = src
    ? `<clipPath id="lkc${i}"><circle cx="${cx}" cy="${cy}" r="17"/></clipPath><image href="${esc(src)}" x="${cx - 17}" y="${cy - 17}" width="34" height="34" clip-path="url(#lkc${i})" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="17" style="fill:hsl(${hue(a.id)} 62% 68%)"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" font-weight="600" style="fill:#0d1214">${esc([...a.label][0] ?? "?")}</text>`;
  const n = Math.floor((b.w - 60) / 7);
  const chans = a.channels.map((c) => `${ARROW[c.dir]} ${c.name}`).join(" · ");
  const body = `<rect class="nd${a.kind === "lead" ? " lead" : ""}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="14"/>${pic}
<text x="${b.x + 52}" y="${b.y + 20}" font-size="14" font-weight="600">${esc(clip(a.label, n - 6))} <tspan class="mu" font-size="11.5" font-weight="400">${KIND[a.kind]}</tspan></text>
<text x="${b.x + 52}" y="${b.y + 38}" font-size="12">${esc(clip(a.cli, n))}</text>
<text class="${a.provider && a.model ? "mu" : "un"}" x="${b.x + 52}" y="${b.y + 54}" font-size="12">${esc(clip(modelOf(a), n))}</text>
<text class="mu" x="${b.x + 52}" y="${b.y + 70}" font-size="11">${esc(clip(chans || (a.via ?? ""), n + 4))}</text>`;
  const href = rowHref(a);
  return href ? `<a href="${esc(href)}">${body}</a>` : body;
}

export function linksMap(s: LinkSnapshot, imgs: Record<string, string>): string {
  const groups = byComputer(s.actors);
  const boxes = new Map<string, Box>();
  const parts: string[] = [];
  let y = 12;
  for (const [computer, list] of groups) {
    const top = y;
    y += 30;
    for (const a of list) {
      boxes.set(a.id, { x: X.work + 12, y, w: WIDTH.work - 24, h: NODE_H });
      y += NODE_H + 8;
    }
    parts.push(
      `<rect class="gp" x="${X.work}" y="${top}" width="${WIDTH.work}" height="${y - top + 4}" rx="16"/><text class="mu" x="${X.work + 14}" y="${top + 20}" font-size="12.5">🖥 ${esc(computer)} · ${list.length}</text>`,
    );
    y += 18;
  }
  const leads = s.actors.filter((a) => a.kind === "lead" || a.kind === "duty" || a.kind === "standing");
  const lead = leads.find((a) => a.kind === "lead");
  const chans = (lead?.channels ?? []).filter((c) => c.with === "재일 님" || c.with === "Muse");
  const height = Math.max(y, leads.length * (NODE_H + 16) + 40, chans.length * (CH_H + 12) + 40);
  let ly = (height - leads.length * (NODE_H + 16)) / 2;
  for (const a of leads) {
    boxes.set(a.id, { x: X.lead, y: ly, w: WIDTH.lead, h: NODE_H });
    ly += NODE_H + 16;
  }
  const leadBox = boxes.get("lead");
  const top = (height - chans.length * (CH_H + 12)) / 2;
  const chanBox = (i: number): Box => ({ x: X.chan, y: top + i * (CH_H + 12), w: WIDTH.chan, h: CH_H });
  const people = new Map<string, Box>();
  for (const who of new Set(chans.map((c) => c.with))) {
    const ys = chans.flatMap((c, i) => (c.with === who ? [chanBox(i).y + CH_H / 2] : []));
    people.set(who, { x: X.person, y: ys.reduce((n, v) => n + v, 0) / ys.length - 24, w: WIDTH.person, h: 48 });
  }
  chans.forEach((c, i) => {
    const b = chanBox(i);
    const p = people.get(c.with)!;
    parts.push(
      `<rect class="ch" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12"/><text x="${b.x + 14}" y="${b.y + 25}" font-size="13">${esc(c.name)}</text>`,
      edge(p, b, c.dir === "out" ? "in" : c.dir === "in" ? "out" : "both"),
      ...(leadBox ? [edge(b, leadBox, c.dir === "out" ? "out" : c.dir === "in" ? "in" : "both")] : []),
    );
  });
  for (const [who, p] of people)
    parts.push(
      `<rect class="nd" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="24"/><text x="${p.x + p.w / 2}" y="${p.y + 29}" text-anchor="middle" font-size="14" font-weight="600">${who === "재일 님" ? "🙋 " : ""}${esc(who)}</text>`,
    );
  for (const a of s.actors)
    for (const f of a.from) {
      const [from, to] = [boxes.get(f), boxes.get(a.id)];
      if (from && to && from.x !== to.x)
        parts.push(edge(from, to, a.kind === "lane" ? "both" : "in", f === "lead" ? "" : "sd"));
    }
  const nodes = s.actors.flatMap((a, i) => {
    const b = boxes.get(a.id);
    return b ? [node(a, b, imgs, i)] : [];
  });
  return `<div class="lkm"><svg viewBox="0 0 ${SVG_W} ${Math.ceil(height)}" role="img" aria-label="연결 지도">${parts.join("")}${nodes.join("")}</svg></div>`;
}

export function linksPane(s: LinkSnapshot | null, imgs: Record<string, string>): string {
  const head = `<header class="rec-h"><div class="title"><b>연결 지도</b><span class="meta">재일 님 → 채널 → 도리도라 → lane·봇 (컴퓨터별) · ${s ? `${kst(s.generatedAt)} KST 기준` : "아직 모으지 않음"}</span></div></header>`;
  const unknown = s?.unknown.length
    ? `<details class="work"><summary>알 수 없음 ${s.unknown.length}</summary><ul class="lku">${s.unknown.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></details>`
    : "";
  return `${head}<section class="thread lkt">${s ? linksMap(s, imgs) : linksList(null, imgs)}${unknown}<p class="note">실선: 도리도라가 일을 넘김 · 점선: 상설 lead가 넘김 · 화살표: 메시지 방향</p></section>`;
}
