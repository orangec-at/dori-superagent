import { esc } from "./board-thread-html.ts";

/**
 * The 문서 tab's markdown: headings, paragraphs, bold/italic/strike, inline code, fenced code, quotes, lists (nested,
 * ordered, task boxes), pipe tables and http(s) links. Every character of the source goes through esc() except the
 * markup made here, so raw HTML in a document shows as text. A link is drawn only for an http(s) URL; images are out of
 * scope and show as their alt text. Each h2 gets an id for the table of contents.
 */
export type TocItem = { id: string; text: string };
export type Rendered = { html: string; toc: TocItem[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const DELIM = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const SAFE_URL = /^https?:\/\/[^\s"'<>`]+$/i;
const blank = (l: string): boolean => l.trim() === "";
const lead = (l: string): number => /^ */.exec(l)![0].length;

const isTable = (lines: string[], i: number): boolean =>
  (lines[i] ?? "").includes("|") && DELIM.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-");

const startsBlock = (lines: string[], i: number): boolean => {
  const l = lines[i]!;
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || isTable(lines, i);
};

/** Inline markup on one block's text; code spans, links and escapes are set aside first so nothing inside them changes. */
export function inline(src: string): string {
  const slots: string[] = [];
  const put = (html: string): string => `\uE000${slots.push(html) - 1}\uE000`;
  const marks = (t: string): string =>
    esc(t)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>");
  const link = (text: string, url: string): string =>
    SAFE_URL.test(url) ? put(`<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${text}</a>`) : text;
  let s = src
    .replace(/\uE000/g, "")
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, c: string) => put(`<code>${esc(c)}</code>`))
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c: string) => put(esc(c)))
    .replace(/(?: {2,}|\\)\n/g, () => put("<br>"))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => put(esc(`[그림: ${alt || "이미지"}]`)))
    .replace(/\[([^\]]+)\]\(<?([^)\s>]*)>?(?:\s+"[^"]*")?\)/g, (_, text: string, url: string) =>
      link(put(marks(text)), url),
    )
    .replace(/<(https?:\/\/[^\s<>]+)>/g, (_, url: string) => link(put(esc(url)), url))
    .replace(/\bhttps?:\/\/[^\s<>()\uE000]*[^\s<>().,;:!?'"\uE000]/g, (url) => link(put(esc(url)), url));
  s = marks(s);
  while (s.includes("\uE000")) s = s.replace(/\uE000(\d+)\uE000/g, (_, n: string) => slots[Number(n)] ?? "");
  return s;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

function table(lines: string[], i: number): [string, number] {
  const head = cells(lines[i]!);
  const align = cells(lines[i + 1]!).map((d) =>
    d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : "",
  );
  const cell = (tag: string, c: string, k: number): string =>
    `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
  const rows: string[] = [];
  let j = i + 2;
  for (; j < lines.length && !blank(lines[j]!) && lines[j]!.includes("|"); j++) {
    const r = cells(lines[j]!);
    rows.push(`<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`);
  }
  const thead = `<thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead>`;
  return [`<div class="tbl"><table>${thead}<tbody>${rows.join("")}</tbody></table></div>`, j];
}

function list(lines: string[], i: number, toc: TocItem[] | null): [string, number] {
  const first = ITEM.exec(lines[i]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let j = i;
  while (j < lines.length) {
    const m = ITEM.exec(lines[j]!);
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
    const inner = indent + m[2]!.length + 1;
    const body = [m[3]!];
    for (j++; j < lines.length; j++) {
      const l = lines[j]!;
      if (blank(l)) {
        const next = lines.slice(j + 1).find((x) => !blank(x));
        if (next === undefined || lead(next) <= indent) break;
        body.push("");
      } else if (lead(l) > indent) body.push(l.slice(Math.min(lead(l), inner)));
      else if (!startsBlock(lines, j) && !blank(body.at(-1)!)) body.push(l);
      else break;
    }
    let html = blocks(body, toc);
    if (html.startsWith("<p>")) html = html.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
    html = html.replace(/^\[([ xX])\] /, (_, x: string) => (x === " " ? "☐ " : "☑ "));
    items.push(`<li>${html}</li>`);
  }
  const start = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}${start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</${tag}>`, j];
}

/** The block level; `toc` collects the h2 headings of the document itself (null inside a quote). */
function blocks(lines: string[], toc: TocItem[] | null): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      const code: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      const lang = fence[2] ? ` class="lang-${esc(fence[2])}"` : "";
      out.push(`<pre><code${lang}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      const n = h[1]!.length;
      const text = h[2]!;
      let id = "";
      if (n === 2 && toc) {
        id = `s-${toc.length + 1}`;
        toc.push({ id, text: text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "") });
      }
      out.push(`<h${n}${id ? ` id="${id}"` : ""}>${inline(text)}</h${n}>`);
      i++;
      continue;
    }
    if (HR.test(l)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) q.push(lines[i]!.replace(QUOTE, ""));
      out.push(`<blockquote>${blocks(q, null)}</blockquote>`);
      continue;
    }
    if (isTable(lines, i) || ITEM.test(l)) {
      const [html, next] = isTable(lines, i) ? table(lines, i) : list(lines, i, toc);
      out.push(html);
      i = next;
      continue;
    }
    const para = [l];
    for (i++; i < lines.length && !blank(lines[i]!) && !startsBlock(lines, i); i++) para.push(lines[i]!);
    out.push(`<p>${inline(para.map((x) => x.replace(/^ +/, "")).join("\n"))}</p>`);
  }
  return out.join("\n");
}

export function renderMd(src: string): Rendered {
  const toc: TocItem[] = [];
  const html = blocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), toc);
  return { html, toc };
}
