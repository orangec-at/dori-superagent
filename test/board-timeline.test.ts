import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownerCounts, parseTimeline, readTimelines, type Timeline } from "../src/board-timeline.ts";
import { linkOf, stagePath, timelinePane, timelineTab } from "../src/board-timeline-html.ts";
import { start, tailnet } from "./board-setup.ts";

const item = (o: Record<string, unknown> = {}) => ({
  id: "a",
  name: "명상 타이머",
  stage: "개발",
  state: "진행",
  next: "알람 정하기",
  owner: "재일 님",
  target: "",
  ...o,
});
const file = (items: unknown[], o: Record<string, unknown> = {}) =>
  JSON.stringify({
    project: "drawhatha",
    title: "드로우하타 일정",
    updatedAt: "2026-11-20 22:50 KST",
    stages: ["기획", "디자인", "개발", "리뷰"],
    note: "날짜는 정해진 것만",
    items,
    ...o,
  });
const timelinesIn = (home: string, files: Record<string, string>): void => {
  mkdirSync(join(home, "timelines"), { recursive: true });
  for (const [n, text] of Object.entries(files)) writeFileSync(join(home, "timelines", n), text);
};

test("a well-formed file reads as written; size and link are optional", () => {
  const t = parseTimeline(file([item(), item({ id: "b", size: "S 1", link: "https://x.test/pull/9" })]))!;
  expect(t).toMatchObject({ project: "drawhatha", title: "드로우하타 일정", updatedAt: "2026-11-20 22:50 KST" });
  expect(t.note).toBe("날짜는 정해진 것만");
  expect(t.dropped).toBe(0);
  expect(t.items[0]).toEqual({
    id: "a",
    name: "명상 타이머",
    stage: "개발",
    state: "진행",
    next: "알람 정하기",
    owner: "재일 님",
    target: "",
    size: "",
    link: "",
  });
  expect(t.items[1]).toMatchObject({ size: "S 1", link: "https://x.test/pull/9" });
});

test("no folder, broken JSON or a file that is not a timeline: nothing is read and the tab says so", () => {
  const s = start();
  expect(readTimelines(s.home)).toEqual([]);
  timelinesIn(s.home, { "a.json": "{ broken", "b.json": JSON.stringify({ project: "x" }), "c.json": "[]" });
  expect(readTimelines(s.home)).toEqual([]);
  expect(timelineTab([])).toContain("일정 자료가 없어요");
  expect(timelinePane([])).toContain("일정 자료가 없어요");
});

test("a stage not in stages reads as null and shows 단계 미정; items of the wrong shape are left out and counted", () => {
  const t = parseTimeline(
    file([item({ stage: "출시" }), item({ state: "끝" }), item({ owner: 3 }), "x", item({ link: 7 }), item()]),
  )!;
  expect(t.items.map((i) => i.stage)).toEqual([null, "개발"]);
  expect(t.dropped).toBe(4);
  expect(stagePath(t, t.items[0]!)).toBe("<b>단계 미정</b>");
  expect(stagePath(t, t.items[1]!)).toBe("기획 → 디자인 → <b>개발</b>");
  expect(timelineTab([t])).toContain("형식이 맞지 않는 항목 4개는 뺐어요.");
  expect(timelinePane([t])).toContain("<small>단계 미정</small>");
});

test("several files are grouped per project in file-name order", () => {
  const s = start();
  timelinesIn(s.home, { "b.json": file([item()], { project: "b", title: "B" }), "a.json": file([], { project: "a" }) });
  const ts = readTimelines(s.home);
  expect(ts.map((t) => t.project)).toEqual(["a", "b"]);
  expect(timelineTab(ts).match(/<section class="tlx" data-project="/g)).toHaveLength(2);
});

test("every field is escaped, a non-http link stays text, and the turn summary counts each owner", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const t = parseTimeline(
    file([
      item({ name: evil, next: evil, owner: "재일 님", size: evil, link: "javascript:alert(1)" }),
      item({ id: "b", owner: "보경 님", link: "https://github.com/o/r/pull/99" }),
      item({ id: "c", owner: "보경 님", target: "12월 1일" }),
    ]),
  ) as Timeline;
  expect(ownerCounts(t)).toEqual([
    ["재일 님", 1],
    ["보경 님", 2],
  ]);
  for (const html of [timelineTab([t]), timelinePane([t])]) {
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(1)");
    expect(html).toContain('href="https://github.com/o/r/pull/99"');
    expect(html).toContain(
      '누구 차례: <span class="tlo"><b>재일 님</b> 1</span> · <span class="tlo"><b>보경 님</b> 2</span>',
    );
    expect(html).toContain("미정");
    expect(html).toContain("12월 1일");
  }
  expect(linkOf("ftp://x")).toBe("ftp://x");
  expect(linkOf('https://x.test/"a')).toBe(
    '<a href="https://x.test/&quot;a" target="_blank" rel="noopener noreferrer">x.test/&quot;a</a>',
  );
});

test("the 일정 tab is served after 사무실, read only, with the list and the wide pane", async () => {
  const s = start();
  timelinesIn(s.home, { "drawhatha.json": file([item()]) });
  const html = await (await fetch(`${s.url}/?tab=timeline`, { headers: tailnet() })).text();
  expect(html).toContain('사무실</a><a class="tab on" href="/?tab=timeline">일정</a>');
  expect(html).toContain('<section class="tlx" data-project="drawhatha">');
  expect(html).toContain('<div class="tld"><section data-project="drawhatha">');
  expect(html).not.toContain('class="dt"');
  const work = await (await fetch(`${s.url}/`, { headers: tailnet() })).text();
  expect(work).toContain('<a class="tab" href="/?tab=timeline">일정</a>');
  expect(work).not.toContain('class="tld"');
});
