import { expect, test } from "bun:test";
import { inline, renderMd } from "../src/docs-md.ts";

const html = (md: string): string => renderMd(md).html;

test("raw HTML in a document is shown as text, in a paragraph, a heading, a table and inline code", () => {
  const out = html(
    "<script>alert(1)</script>\n\n# <img src=x onerror=alert(1)>\n\n| <b>a</b> |\n|---|\n| <iframe> |\n\n`<i>`",
  );
  expect(out).not.toMatch(/<(script|img|iframe|b|i)[\s>]/);
  expect(out).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  expect(out).toContain("<h1>&lt;img src=x onerror=alert(1)&gt;</h1>");
  expect(out).toContain("<th>&lt;b&gt;a&lt;/b&gt;</th>");
  expect(out).toContain("<code>&lt;i&gt;</code>");
});

test("only http(s) links are drawn, with rel=noopener noreferrer; javascript: and data: stay text", () => {
  expect(inline("[보드](https://example.com/a?b=1&c=2)")).toBe(
    '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">보드</a>',
  );
  for (const bad of ["[x](javascript:alert(1))", "[x](JAVASCRIPT:alert(1))", "[x](data:text/html,hi)", "[x](/local)"])
    expect(inline(bad)).not.toContain("<a ");
  expect(inline('[x](https://a.example/"onmouseover=alert(1))')).not.toContain('"onmouseover');
  expect(inline("참고 https://example.com/x.")).toBe(
    '참고 <a href="https://example.com/x" rel="noopener noreferrer" target="_blank">https://example.com/x</a>.',
  );
  expect(inline("![그림](https://example.com/a.png)")).toBe("[그림: 그림]");
});

test("inline marks: bold, italic, strike and code, where code keeps its stars", () => {
  expect(inline("**굵게** *기울임* ~~취소~~ `a**b**`")).toBe(
    "<strong>굵게</strong> <em>기울임</em> <del>취소</del> <code>a**b**</code>",
  );
  expect(inline("2 * 3 * 4 and \\*not\\*")).toBe("2 * 3 * 4 and *not*");
});

test("blocks: headings with a toc of h2, nested lists, ordered start, quotes, fenced code and an hr", () => {
  const r = renderMd(
    "# 제목\n\n## 하나 **굵게**\n\n- 가\n  - 나\n- [x] 다\n\n3. 셋\n4. 넷\n\n> 인용 **굵게**\n\n```ts\nconst a = '<b>';\n```\n\n---\n\n## 둘\n",
  );
  expect(r.toc).toEqual([
    { id: "s-1", text: "하나 굵게" },
    { id: "s-2", text: "둘" },
  ]);
  expect(r.html).toContain('<h2 id="s-1">하나 <strong>굵게</strong></h2>');
  expect(r.html).toContain("<ul><li>가\n<ul><li>나</li></ul></li><li>☑ 다</li></ul>");
  expect(r.html).toContain('<ol start="3"><li>셋</li><li>넷</li></ol>');
  expect(r.html).toContain("<blockquote><p>인용 <strong>굵게</strong></p></blockquote>");
  expect(r.html).toContain('<pre><code class="lang-ts">const a = &#39;&lt;b&gt;&#39;;</code></pre>');
  expect(r.html).toContain("<hr>");
});

test("a pipe table sits in a scroll box with its alignment; a table right after a paragraph line still parses", () => {
  const out = html("표는:\n| 이름 | 값 |\n|:---|---:|\n| a \\| b | **1** |\n| c |\n");
  expect(out).toContain("<p>표는:</p>");
  expect(out).toContain(
    '<div class="tbl"><table><thead><tr><th style="text-align:left">이름</th><th style="text-align:right">값</th></tr></thead>',
  );
  expect(out).toContain('<td style="text-align:left">a | b</td><td style="text-align:right"><strong>1</strong></td>');
  expect(out).toContain('<td style="text-align:left">c</td><td style="text-align:right"></td>');
});
