import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSheets } from "../src/board-sheets.ts";
import { HOST, LOGIN, NOW, PHONE, post, start, tailnet, tokenOf } from "./board-setup.ts";

const page = async (url: string, q: string, headers = tailnet()): Promise<string> =>
  (await fetch(`${url}/?tab=sheets${q}`, { headers })).text();
const fileOf = (home: string, id: string) => JSON.parse(readFileSync(join(home, "sheets", `${id}.json`), "utf8"));
const AT = new Date(NOW).toISOString();
const json = tailnet({ accept: "application/json" });

async function made(s: ReturnType<typeof start>, name = "가계부"): Promise<{ id: string; csrf: string }> {
  const csrf = await tokenOf(s.url);
  const res = await post(s.url, "/sheets", { csrf, action: "new", name }, tailnet());
  expect(res.status).toBe(303);
  const id = /s=([a-z0-9-]+)$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  expect(res.headers.get("location")).toBe(`/?tab=sheets&s=${id}`);
  return { id, csrf };
}

test("a new sheet is listed and opens in the editor, which only that page loads", async () => {
  const s = start();
  expect(await page(s.url, "")).toContain("아직 시트가 없어요");
  const { id } = await made(s);
  expect(id).toMatch(/^2026-11-13-[0-9a-f]{8}$/);
  const f = fileOf(s.home, id);
  expect(f.rev).toBe(1);
  expect(f.snapshot.name).toBe("가계부");
  expect(listSheets(s.home)).toEqual([{ id, name: "가계부", rev: 1, savedAt: AT }]);
  const list = await page(s.url, "");
  expect(list).toContain('<a class="tab on" href="/?tab=sheets">시트</a>');
  expect(list).toContain(`href="/?tab=sheets&amp;s=${id}"`);
  expect(list).toContain("고친 시각 11-13 10:00 KST · 1판");
  expect(list).not.toContain("/sheets/sheets.js");
  const open = await page(s.url, `&s=${id}`);
  expect(open).toContain(`data-sheet="${id}" data-rev="1" data-csrf="`);
  expect(open).toMatch(/<script type="module" src="\/sheets\/sheets\.js\?v=[0-9a-z]+"><\/script>/);
  expect(open).toContain('<body class="has-c">');
  expect(await (await fetch(`${s.url}/`, { headers: tailnet() })).text()).not.toContain("sheets.js");
  expect(await page(s.url, "&s=nope")).toContain("찾을 수 없는 시트예요");
});

test("a save from the rev the page opened is written; one from an older rev is refused with 409", async () => {
  const s = start();
  const { id, csrf } = await made(s);
  const snap = {
    id,
    name: "가계부",
    sheets: { sheet1: { cellData: { 0: { 0: { v: "</script><script>alert(1)</script>" } } } } },
  };
  const save = (rev: string, snapshot = JSON.stringify(snap)) =>
    post(s.url, "/sheets", { csrf, action: "save", id, rev, snapshot }, json);
  const ok = await save("1");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ rev: 2, savedAt: AT });
  expect(fileOf(s.home, id)).toEqual({ rev: 2, savedAt: AT, snapshot: snap });
  // A second device still on rev 1: refused, the first save stays.
  const late = await save("1", JSON.stringify({ name: "덮어쓰기" }));
  expect(late.status).toBe(409);
  expect(fileOf(s.home, id).snapshot).toEqual(snap);
  for (const [form, status] of [
    [{ action: "save", id, rev: "2", snapshot: "[1]" }, 400],
    [{ action: "save", id, rev: "2", snapshot: "{ broken" }, 400],
    [{ action: "save", id: "nope", rev: "1", snapshot: "{}" }, 404],
    [{ action: "save", id: "../board", rev: "1", snapshot: "{}" }, 404],
    [{ action: "delete", id }, 400],
    [{ action: "new", name: "x".repeat(81) }, 413],
  ] as const)
    expect((await post(s.url, "/sheets", { csrf, ...form }, json)).status).toBe(status);
  expect(fileOf(s.home, id).rev).toBe(2);
  expect(readdirSync(join(s.home, "sheets"))).toEqual([`${id}.json`]);
  // The cell text cannot close the JSON block the page carries the snapshot in.
  const open = await page(s.url, `&s=${id}`);
  expect(open).toContain('data-rev="2"');
  expect(open).not.toContain("</script><script>alert(1)");
  expect(open).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
});

test("a write that fails the board's checks is refused and writes nothing; a reader sees the sheet read-only", async () => {
  const s = start();
  const { id, csrf } = await made(s);
  const before = readFileSync(join(s.home, "sheets", `${id}.json`), "utf8");
  const save = { csrf, action: "save", id, rev: "1", snapshot: "{}" };
  const denied: [Record<string, string>, Record<string, string>][] = [
    [save, tailnet({ "tailscale-user-login": "someone@else.com" })],
    [save, tailnet({ "x-forwarded-for": "100.64.0.99" })],
    [save, tailnet({ "x-forwarded-for": `${PHONE}, 100.64.0.99` })],
    [save, tailnet({ origin: "https://evil.example" })],
    [save, tailnet({ "sec-fetch-site": "cross-site" })],
    [{ ...save, csrf: "0".repeat(64) }, tailnet()],
    [{ ...save, csrf: "" }, tailnet()],
    [{ csrf, action: "new", name: "몰래" }, tailnet({ "tailscale-user-login": "someone@else.com" })],
    [save, { host: "127.0.0.1", origin: "https://127.0.0.1", "tailscale-user-login": LOGIN, "x-forwarded-for": PHONE }],
  ];
  for (const [f, h] of denied) expect((await post(s.url, "/sheets", f, h)).status).toBe(403);
  expect((await post(s.url, "/sheets", save, tailnet({ host: "evil.example" }))).status).toBe(403);
  expect(readFileSync(join(s.home, "sheets", `${id}.json`), "utf8")).toBe(before);
  expect(readdirSync(join(s.home, "sheets"))).toEqual([`${id}.json`]);
  expect(s.logs.filter((l) => l.startsWith("BOARD_REJECT")).length).toBe(denied.length + 1);
  const reader = await page(s.url, `&s=${id}`, { host: HOST, "x-forwarded-for": PHONE });
  expect(reader).toContain(`data-sheet="${id}" data-rev="1" data-csrf=""`);
  expect(reader).toContain("읽기 전용이에요.");
  expect(reader).not.toContain('id="shsave"');
  expect((await fetch(`${s.url}/?tab=sheets&s=${id}`, { headers: { host: "evil.example" } })).status).toBe(403);
});

test("the editor bundle is served gzipped from assets/board/sheets only", async () => {
  const s = start();
  const res = await fetch(`${s.url}/sheets/sheets.js`, { headers: { host: HOST, "accept-encoding": "gzip" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-encoding")).toBe("gzip");
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect((await res.text()).length).toBeGreaterThan(1_000_000);
  expect((await fetch(`${s.url}/sheets/sheets.css`, { headers: { host: HOST } })).status).toBe(200);
  for (const p of ["/sheets/nope.js", "/sheets/..%2Fboard.js", "/sheets/sheets.js.map", "/sheets/a/b.js"])
    expect((await fetch(`${s.url}${p}`, { headers: { host: HOST } })).status).toBe(404);
  expect(existsSync(join(s.home, "sheets"))).toBe(false);
});
