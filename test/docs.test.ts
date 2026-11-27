import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDoc, docsView, docUrl, isDocId, listDocs, parseDoc, readDoc } from "../src/docs.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), "dori-docs-"));
  homes.push(h);
  return h;
};

test("an id is YYYY-MM-DD-name of letters, digits and hyphens; a path out of docs/ is refused", () => {
  expect(isDocId("2026-11-27-board-docs")).toBe(true);
  for (const bad of [
    "../secret",
    "2026-11-27-../../x",
    "2026-11-27-a/b",
    "2026-11-27-a.md",
    "board",
    "2026-11-27-",
    "",
  ])
    expect(isDocId(bad)).toBe(false);
  const h = home();
  writeFileSync(join(h, "secret.md"), "---\ntitle: 비밀\n---\n");
  expect(readDoc(h, "../secret")).toBeNull();
  expect(docsView(h, null, "../secret")).toMatchObject({ open: null, missing: true });
  expect(() => addDoc(h, "x", { title: "t", name: "a.md", id: "../../etc/x" }, NOW)).toThrow("doc id must look like");
});

test("front matter: quoted and plain values are read, the body follows it, a text without one is all body", () => {
  const { meta, body } = parseDoc(
    `---\ntitle: "보고서: \\"1차\\""\ndate: 2026-11-27T06:00:00.000Z\nproject: 'drawhatha'\n---\n# 본문\n`,
  );
  expect(meta).toEqual({ title: '보고서: "1차"', date: "2026-11-27T06:00:00.000Z", project: "drawhatha" });
  expect(body).toBe("# 본문\n");
  expect(parseDoc("# 제목\n---\n")).toEqual({ meta: {}, body: "# 제목\n---\n" });
});

test("add writes front matter and body, names the id from today in KST and the file, and keeps the old version", () => {
  const h = home();
  const id = addDoc(
    h,
    "---\ntitle: old\n---\n# 첫 판\n",
    { title: " 주간\n보고 ", name: "Weekly Report.md", project: "dori" },
    NOW,
  );
  expect(id).toBe("2026-11-13-weekly-report");
  expect(readFileSync(join(h, "docs", `${id}.md`), "utf8")).toBe(
    `---\ntitle: "주간 보고"\ndate: "2026-11-13T01:00:00.000Z"\nproject: "dori"\n---\n# 첫 판\n`,
  );
  expect(readDoc(h, id)).toEqual({
    id,
    title: "주간 보고",
    date: "2026-11-13T01:00:00.000Z",
    project: "dori",
    body: "# 첫 판\n",
  });
  expect(addDoc(h, "# 둘째 판\n", { title: "주간 보고", name: "x.md", id }, NOW + 60_000)).toBe(id);
  expect(readDoc(h, id)?.body).toBe("# 둘째 판\n");
  const kept = readdirSync(join(h, "docs", ".history", id));
  expect(kept).toEqual(["2026-11-13T01-01-00-000Z.md"]);
  expect(readFileSync(join(h, "docs", ".history", id, kept[0]!), "utf8")).toContain("# 첫 판");
  expect(addDoc(h, "x", { title: "t", name: "보고서.md" }, NOW)).toMatch(/^2026-11-13-doc-[0-9a-f]{6}$/);
  expect(() => addDoc(h, "x", { title: "  ", name: "a.md" }, NOW)).toThrow("--title must not be empty");
});

test("the list is newest date first, filters by project, and skips files that are not documents", () => {
  const h = home();
  addDoc(h, "a", { title: "가", name: "2026-11-01-a.md", project: "dori" }, NOW - 2 * 86_400_000);
  addDoc(h, "b", { title: "나", name: "2026-11-02-b.md", project: "drawhatha" }, NOW);
  addDoc(h, "c", { title: "다", name: "2026-11-03-c.md" }, NOW - 86_400_000);
  writeFileSync(join(h, "docs", "notes.txt"), "x");
  mkdirSync(join(h, "docs", "Bad.Name.md"), { recursive: true });
  expect(listDocs(h).map((m) => m.title)).toEqual(["나", "다", "가"]);
  const v = docsView(h, "dori", null);
  expect(v.list.map((m) => m.id)).toEqual(["2026-11-01-a"]);
  expect(v.projects).toEqual(["dori", "drawhatha"]);
});

test("the link takes board.json publicUrl when it is an origin, else the path alone", () => {
  const h = home();
  expect(docUrl(h, "2026-11-27-a")).toBe("/?tab=docs&d=2026-11-27-a");
  writeFileSync(join(h, "board.json"), JSON.stringify({ publicUrl: "https://fedora.example.ts.net:8446/" }));
  expect(docUrl(h, "2026-11-27-a")).toBe("https://fedora.example.ts.net:8446/?tab=docs&d=2026-11-27-a");
  writeFileSync(join(h, "board.json"), JSON.stringify({ publicUrl: "javascript:alert(1)//" }));
  expect(docUrl(h, "2026-11-27-a")).toBe("/?tab=docs&d=2026-11-27-a");
});

test("the board's 문서 tab lists the documents, filters by project and opens one; raw HTML stays text", async () => {
  const s = start();
  const page = async (q: string): Promise<string> => (await fetch(`${s.url}/${q}`, { headers: tailnet() })).text();
  expect(await page("")).toContain('<a class="tab" href="/?tab=docs">문서</a>');
  expect(await page("?tab=docs")).toContain("아직 문서가 없어요.");
  const id = addDoc(
    s.home,
    "## 개요\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    { title: "보드 <문서>", name: "plan.md", project: "dori", summary: "한 줄" },
    NOW,
  );
  addDoc(s.home, "x", { title: "다른 문서", name: "other.md", project: "drawhatha" }, NOW - 60_000);
  const list = await page("?tab=docs");
  expect(list).toContain('<a class="tab on" href="/?tab=docs">문서</a>');
  expect(list).toContain(`href="/?tab=docs&amp;d=${id}"`);
  expect(list).toContain("<b>보드 &lt;문서&gt;</b>");
  expect(list.indexOf("보드 &lt;문서&gt;")).toBeLessThan(list.indexOf("다른 문서"));
  const only = await page("?tab=docs&p=drawhatha");
  expect(only).toContain('<a class="chip on" href="/?tab=docs&amp;p=drawhatha">drawhatha</a>');
  expect(only).not.toContain("보드 &lt;문서&gt;");
  const open = await page(`?tab=docs&d=${id}`);
  expect(open).toContain('<body class="has-c">');
  expect(open).toContain('<a class="back" href="/?tab=docs" aria-label="목록으로">← 목록</a>');
  expect(open).toContain('<li><a href="#s-1">개요</a></li>');
  expect(open).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(open).not.toContain("<script>alert(1)");
  expect(open).toContain('<div class="tbl"><table>');
  expect(await page("?tab=docs&d=2026-01-01-nope")).toContain("찾을 수 없는 문서예요.");
  expect(await page("?tab=docs&d=../../board")).toContain("찾을 수 없는 문서예요.");
  expect((await fetch(`${s.url}/?tab=docs`, { headers: { host: "evil.example" } })).status).toBe(403);
});
