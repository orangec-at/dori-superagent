import { esc } from "./board-thread-html.ts";
import type { DocsView } from "./docs.ts";
import { renderMd } from "./docs-md.ts";

/**
 * The open document reads on a phone first: 16-17px text, line height 1.6, side margins, Korean kept whole per word.
 * A wide table or code block scrolls sideways in its own box instead of widening the page.
 */
export const DOCS_STYLE = `.doc{width:100%}.doc .title .meta{display:block}.doc .back{font-size:16px}
.md{width:100%;max-width:760px;margin:0 auto;padding:14px 18px 56px;font-size:16.5px;line-height:1.6;word-break:keep-all;overflow-wrap:break-word}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{line-height:1.35;margin:1.5em 0 .5em;scroll-margin-top:72px}.md h1{font-size:1.45em}.md h2{font-size:1.25em;padding-bottom:.25em;border-bottom:1px solid var(--line)}.md h3{font-size:1.1em}.md h4,.md h5,.md h6{font-size:1em}
.md>:first-child{margin-top:0}.md p,.md ul,.md ol,.md blockquote,.md pre,.md .tbl{margin:0 0 1em}.md ul,.md ol{padding-left:1.4em}.md li{margin:.3em 0}.md li>ul,.md li>ol{margin:.3em 0}
.md blockquote{margin-left:0;padding:.1em 0 .1em 1em;border-left:3px solid var(--line);color:var(--muted)}.md hr{border:0;border-top:1px solid var(--line);margin:1.8em 0}
.md a{text-decoration:underline;text-underline-offset:2px}.md code{font:.87em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);padding:.1em .35em;border-radius:5px}
.md pre{overflow-x:auto;padding:12px 14px;background:var(--panel);border-radius:10px;word-break:normal}.md pre code{padding:0;background:none;font-size:13.5px;white-space:pre}
.md .tbl{overflow-x:auto;border:1px solid var(--line);border-radius:10px}.md table{border-collapse:collapse;min-width:100%;font-size:14.5px;line-height:1.45}
.md th,.md td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;min-width:4.5em}.md th+th,.md td+td{border-left:1px solid var(--line)}
.md th{background:var(--panel);font-weight:600;white-space:nowrap}.md tbody tr:last-child td{border-bottom:0}.dsum{color:var(--muted);margin:0 0 14px}
.toc{margin:0 0 18px;padding:8px 14px;background:var(--panel);border-radius:10px;font-size:15px;line-height:1.5}.toc summary{cursor:pointer;font-weight:600;color:var(--muted)}.toc ol{margin:8px 0 2px;padding-left:1.4em}.toc li{margin:.35em 0}`;

const KST = 9 * 3_600_000;
const kstOf = (iso: string, n: number): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + KST).toISOString().slice(0, n).replace("T", " ");
};
const hrefOf = (p: string | null, d: string | null = null): string => {
  const q = new URLSearchParams({ tab: "docs" });
  if (p) q.set("p", p);
  if (d) q.set("d", d);
  return `/?${q}`;
};

/** The list: a chip per project (`&p=` keeps one), then the documents newest first with their one-line summary. */
export function docsTab(v: DocsView | null): string {
  const p = v?.p ?? null;
  const all = v?.projects ?? [];
  const chip = (label: string, to: string | null): string =>
    `<a class="chip${to === p ? " on" : ""}" href="${esc(hrefOf(to))}">${esc(label)}</a>`;
  const chips = all.length
    ? `<nav class="chips">${chip("전체", null)}${all.map((x) => chip(x, x)).join("")}</nav>`
    : "";
  const rows = (v?.list ?? [])
    .map(
      (m) =>
        `<a class="row${m.id === v?.open?.id ? " on" : ""}" href="${esc(hrefOf(p, m.id))}"><span class="rb"><span class="rt"><b>${esc(m.title)}</b>` +
        `<span class="ago">${esc(kstOf(m.date, 10))}</span></span><span class="rs">${m.project ? `<span class="proj">${esc(m.project)}</span>${m.summary ? " · " : ""}` : ""}${esc(m.summary ?? "")}</span></span></a>`,
    )
    .join("");
  const empty = p ? "이 프로젝트의 문서가 없어요." : "아직 문서가 없어요.";
  return chips + (rows || `<p class="note">${empty}</p>`);
}

/** The open document: a sticky header (← 목록, title, date · project), the h2 table of contents folded, the body. */
export function docPane(v: DocsView | null): string {
  if (!v?.open) return `<p class="note">${v?.missing ? "찾을 수 없는 문서예요." : "문서를 고르면 여기서 읽어요."}</p>`;
  const d = v.open;
  const { html, toc } = renderMd(d.body);
  const meta = [`${kstOf(d.date, 16)} KST`, d.project ?? ""].filter(Boolean).map(esc).join(" · ");
  const contents = toc.length
    ? `<details class="toc"><summary>목차 ${toc.length}</summary><ol>${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join("")}</ol></details>`
    : "";
  return (
    `<div class="doc"><header class="rec-h"><a class="back" href="${esc(hrefOf(v.p))}" aria-label="목록으로">← 목록</a>` +
    `<div class="title"><b>${esc(d.title)}</b><span class="meta">${meta}</span></div></header>` +
    `<article class="md">${contents}${d.summary ? `<p class="dsum">${esc(d.summary)}</p>` : ""}${html}</article></div>`
  );
}
