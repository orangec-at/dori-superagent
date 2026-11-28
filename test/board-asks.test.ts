import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askAdd, askFor, asks, parseFor, parseOptions, readAsk } from "../src/asks.ts";
import { byPerson, byProject } from "../src/board-asks.ts";
import { main } from "../src/cli.ts";
import { NOW, post, start, tailnet, tokenOf } from "./board-setup.ts";
import { setup } from "./harness-setup.ts";

const options = parseOptions(["A=yes", "B=no"]);
const page = async (url: string, q = ""): Promise<string> =>
  (await fetch(`${url}/${q}`, { headers: tailnet() })).text();
const listOf = (html: string): string => html.split('aria-label="작업 목록"')[1]?.split("</aside>")[0] ?? "";
/** The open ask fixture start() adds (vg-analytics, jaeil's), plus three of bokyung's and one more of jaeil's. */
function withPeople() {
  const b = start();
  for (const [i, id] of ["bk-copy", "bk-price", "bk-store"].entries())
    askAdd(b.home, id, { question: `보경 질문 ${i}`, options, for: "bokyung", project: "drawhatha", now: NOW - i });
  askAdd(b.home, "jl-merge", { question: "병합할까?", options, recommend: "A", now: NOW - 10 });
  return b;
}

test("--for and --project are stored; without --for the ask is jaeil's; ask list names the person", async () => {
  const { d } = setup();
  const ask = (id: string, ...extra: string[]) =>
    main(["ask", id, "--question", "카피 괜찮아?", "--option", "A=좋아", "--option", "B=고쳐", ...extra], d);
  expect(await ask("bk-copy", "--for", "bokyung", "--project", "drawhatha")).toBe(0);
  expect(await ask("jl-ship")).toBe(0);
  expect(readAsk(d.store.root, "bk-copy")).toMatchObject({ for: "bokyung", project: "drawhatha" });
  expect(readAsk(d.store.root, "jl-ship")).toMatchObject({ for: "jaeil" });
  expect(readAsk(d.store.root, "jl-ship")?.project).toBeUndefined();
  const lines: string[] = [];
  const log = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    expect(await main(["ask", "list"], d)).toBe(0);
  } finally {
    console.log = log;
  }
  expect(lines).toEqual([
    expect.stringMatching(/^bk-copy for=bokyung project=drawhatha unanswered /),
    expect.stringMatching(/^jl-ship for=jaeil unanswered /),
  ]);
  expect(parseFor(undefined)).toBe("jaeil");
  expect(() => parseFor("muse")).toThrow("--for");
  await expect(ask("bad-for", "--for", "Jaeil")).rejects.toThrow("--for");
  expect(() => askAdd(d.store.root, "p-bad", { question: "q", options, project: " ", now: NOW })).toThrow("--project");
  expect(() => askAdd(d.store.root, "p-bad", { question: "q", options, project: "a\nb", now: NOW })).toThrow(
    "--project",
  );
});

test("an ask file written before --for reads as jaeil's", () => {
  const { d } = setup();
  const dir = join(d.store.root, "asks");
  mkdirSync(dir, { recursive: true });
  const old = { id: "old-one", question: "q", options, status: "open", createdAt: NOW };
  writeFileSync(join(dir, "old-one.json"), JSON.stringify(old));
  const [a] = asks(d.store.root);
  expect(a?.for).toBeUndefined();
  expect(askFor(a!)).toBe("jaeil");
  expect(byPerson(asks(d.store.root)).map((g) => [g.who, g.asks.map((x) => x.id)])).toEqual([
    ["jaeil", ["old-one"]],
    ["bokyung", []],
  ]);
});

test("확인 필요 groups the open asks by person with counts; only jaeil's keep the answer buttons", async () => {
  const { url } = withPeople();
  const html = await page(url, "?tab=asks");
  expect(html).toContain(`href="/?tab=asks">확인 필요 5</a>`);
  const [jaeil, bokyung] = listOf(html).split('id="for-bokyung"');
  expect(jaeil).toContain(`재일 님 <span>2</span>`);
  expect(bokyung).toContain(`보경 님 <span>3</span>`);
  expect(jaeil?.match(/action="\/decide"/g)).toHaveLength(2);
  expect(bokyung).not.toContain('action="/decide"');
  expect(bokyung).toContain("Slack으로 답을 받고 도리도라가 닫아요.");
  expect(bokyung?.match(/<span class="proj">drawhatha<\/span>/g)).toHaveLength(3);
  expect(bokyung).toContain("보경 질문 2");
});

test("bokyung's asks stay out of 재일 님 차례, 내 차례 and the lead's record, and the board will not answer them", async () => {
  const { url, sent, home } = withPeople();
  const work = await page(url);
  expect(work).toContain("내 차례 2</a>");
  expect(work).toContain(`재일 님 차례 <span>2</span>`);
  expect(work).not.toContain("보경 질문");
  const res = await post(url, "/decide", { csrf: await tokenOf(url), id: "bk-copy", choice: "A" }, tailnet());
  expect(res.status).toBe(409);
  expect(sent).toEqual([]);
  expect(readAsk(home, "bk-copy")?.sent).toBeUndefined();
});

test("확인 필요 shows each person's asks newest first with the KST time; one with no readable time goes last", async () => {
  const { url, home } = start();
  const raw = (id: string, createdAt: unknown, who = "bokyung") =>
    writeFileSync(
      join(home, "asks", `${id}.json`),
      JSON.stringify({ id, question: id, options, status: "open", for: who, createdAt }),
    );
  raw("bk-iso", "2026-11-13T02:30:00Z");
  raw("bk-ms", NOW);
  raw("bk-sec", (NOW - 3_600_000) / 1000);
  raw("bk-digits", String(NOW - 7_200_000));
  raw("bk-none", undefined);
  raw("bk-junk", "어제쥔");
  raw("jl-new", NOW, "jaeil");
  expect(byPerson(asks(home)).map((g) => g.asks.map((a) => a.id))).toEqual([
    ["jl-new", "vg-analytics"],
    ["bk-iso", "bk-ms", "bk-sec", "bk-digits", "bk-junk", "bk-none"],
  ]);
  const [jaeil, bokyung] = listOf(await page(url, "?tab=asks")).split('id="for-bokyung"');
  const ids = (html = "") => [...html.matchAll(/id="ask-([\w-]+)"/g)].map((m) => m[1]);
  expect(ids(jaeil)).toEqual(["jl-new", "vg-analytics"]);
  expect(ids(bokyung)).toEqual(["bk-iso", "bk-ms", "bk-sec", "bk-digits", "bk-junk", "bk-none"]);
  expect(jaeil).toContain("결정 · vg-analytics · 11/13 09:59 · 1분 전</p>");
  expect(bokyung).toContain("결정 · bk-iso · 11/13 11:30 · ");
  expect(bokyung).toContain("결정 · bk-sec · 11/13 09:00 · 1시간 전</p>");
  expect(bokyung).toContain("결정 · bk-digits · 11/13 08:00 · 2시간 전</p>");
  expect(bokyung).toContain("결정 · bk-none</p>");
  expect(bokyung).toContain("결정 · bk-junk</p>");
});

test("확인 필요 groups each person's asks by project, the one with the newest ask first and 기타 last", async () => {
  const { url, home } = start();
  const add = (id: string, project: string | undefined, before: number, who: "jaeil" | "bokyung" = "bokyung") =>
    askAdd(home, id, { question: id, options, for: who, ...(project ? { project } : {}), now: NOW - before });
  add("dh-old", "drawhatha", 50_000);
  add("cp-new", "coupas", 1_000);
  add("none-new", undefined, 0);
  add("dh-new", "drawhatha", 500);
  add("vg-mid", "vibeguard", 2_000);
  add("jl-cp", "coupas", 0, "jaeil");
  expect(byPerson(asks(home)).map((g) => byProject(g.asks).map((p) => [p.project, p.asks.map((a) => a.id)]))).toEqual([
    [
      ["coupas", ["jl-cp"]],
      ["기타", ["vg-analytics"]],
    ],
    [
      ["drawhatha", ["dh-new", "dh-old"]],
      ["coupas", ["cp-new"]],
      ["vibeguard", ["vg-mid"]],
      ["기타", ["none-new"]],
    ],
  ]);
  const [, bokyung] = listOf(await page(url, "?tab=asks")).split('id="for-bokyung"');
  const heads = [...(bokyung ?? "").matchAll(/<h4 class="proj-sec">([^<]+) <span>(\d+)<\/span>/g)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  expect(heads).toEqual(["drawhatha 2", "coupas 1", "vibeguard 1", "기타 1"]);
  expect([...(bokyung ?? "").matchAll(/id="ask-([\w-]+)"/g)].map((m) => m[1])).toEqual([
    "dh-new",
    "dh-old",
    "cp-new",
    "vg-mid",
    "none-new",
  ]);
});

test("the 확인 필요 tab escapes the question, options, project and link it shows", async () => {
  const { url, home } = start();
  askAdd(home, "bk-xss", {
    question: `<script>alert(1)</script>`,
    options: parseOptions([`A=<img src=x onerror=alert(1)>`]),
    link: `https://example.com/?a="><b>`,
    project: `<i>p</i>`,
    for: "bokyung",
    now: NOW,
  });
  const html = await page(url, "?tab=asks");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<i>p</i>");
  expect(html).not.toContain(`?a="><b>`);
  expect(html).toContain("?a=&quot;&gt;&lt;b&gt;");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("&lt;i&gt;p&lt;/i&gt;");
});
