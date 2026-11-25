import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Item } from "../src/store-types.ts";
import { BOT_MACHINE, NOW, post, start, tailnet } from "./board-setup.ts";

const JSON_ACCEPT = { accept: "application/json" };
const FORM_ACCEPT = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const CWD = "/home/b/workspace/coupas";

type Reply = { card: string | null; gone: boolean; held: boolean; note: string; bad: boolean; v: string | null };

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  title: `${id} 할 일`,
  brief: "",
  cwd: CWD,
  priority: 5,
  status: "open",
  attempts: 0,
  createdAt: NOW,
  updatedAt: NOW,
  log: [],
  ...over,
});

/** A board whose coupas project has one open item with a decision to answer and one running item. */
function board() {
  const b = start();
  writeFileSync(join(b.home, "board.json"), JSON.stringify({ projects: { coupas: { words: ["coupas"] } } }));
  writeFileSync(join(b.home, "brief.md"), "# brief\n");
  b.store.saveItem(item("coupas-next", { decision: "A or B?", brief: join(b.home, "brief.md") }));
  b.store.saveItem(item("coupas-live", { status: "running" }));
  return b;
}

/** The page's csrf token and the version it shows, as board.js reads them. */
async function pageOf(url: string): Promise<{ csrf: string; v: string }> {
  const html = await (await fetch(`${url}/?tab=proj&p=coupas`, { headers: tailnet() })).text();
  return {
    csrf: /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "",
    v: /name="board-version" content="([0-9a-f]+)"/.exec(html)?.[1] ?? "",
  };
}
const edit = (url: string, form: Record<string, string>, headers = tailnet(JSON_ACCEPT)) =>
  post(url, "/backlog", { p: "coupas", id: "coupas-next", ...form }, headers);

test("a background priority change gets the task's card and the version the next poll answers; a form still gets the redirect", async () => {
  const b = board();
  const { csrf, v } = await pageOf(b.url);
  const res = await edit(b.url, { csrf, v, action: "priority", priority: "1" });
  expect(res.status).toBe(200);
  const j = (await res.json()) as Reply;
  expect(j).toMatchObject({ gone: false, held: false, note: "백로그에 반영했어요.", bad: false });
  expect(j.card).toStartWith('<div class="tk mine" id="t-coupas-next">');
  expect(j.card).toContain("<span>p1</span>");
  expect(j.card).toContain('<option value="1" selected>p1</option>');
  expect(j.card).toContain(`name="csrf" value="${csrf}"`);
  expect(j.v).not.toBe(v);
  expect(((await (await fetch(`${b.url}/api/version`)).json()) as { v: string }).v).toBe(j.v!);
  expect(b.store.item("coupas-next")?.priority).toBe(1);

  const form = await edit(b.url, { csrf, action: "priority", priority: "2" }, tailnet(FORM_ACCEPT));
  expect([form.status, form.headers.get("location")]).toEqual([303, "/?tab=proj&p=coupas&sent=backlog#tasks"]);
  expect(b.store.item("coupas-next")?.priority).toBe(2);
});

test("a background decision answer drops the question from the card; a background drop takes its buttons away", async () => {
  const b = board();
  const { csrf, v } = await pageOf(b.url);
  const answered = (await (await edit(b.url, { csrf, v, action: "decide", text: "A" })).json()) as Reply;
  expect(answered.card).toStartWith('<div class="tk" id="t-coupas-next">');
  expect(answered.card).not.toContain("결정 필요");
  expect(b.store.item("coupas-next")?.decision).toBeUndefined();

  const dropped = (await (await edit(b.url, { csrf, action: "drop" })).json()) as Reply;
  expect(dropped).toMatchObject({ card: null, gone: true, bad: false, v: null });
  expect(b.store.item("coupas-next")?.status).toBe("dropped");
});

test("a background edit the backlog refuses answers 409 as text and changes nothing", async () => {
  const b = board();
  const { csrf } = await pageOf(b.url);
  const live = await edit(b.url, { csrf, id: "coupas-live", action: "priority", priority: "1" });
  expect([live.status, live.headers.get("content-type")]).toEqual([409, "text/plain; charset=utf-8"]);
  expect(b.store.item("coupas-live")?.priority).toBe(5);
});

test("a /backlog edit that fails the writer, device, origin or csrf check is refused alike with or without JSON in Accept", async () => {
  const b = board();
  const { csrf } = await pageOf(b.url);
  const cases: [string, Record<string, string>, Record<string, string>][] = [
    ["another login", { csrf }, { "tailscale-user-login": "someone@example.com" }],
    ["another device", { csrf }, { "x-forwarded-for": BOT_MACHINE }],
    ["other origin", { csrf }, { origin: "https://evil.example" }],
    ["stale csrf", { csrf: "0".repeat(csrf.length) }, {}],
    ["no csrf", {}, {}],
  ];
  for (const [name, auth, headers] of cases)
    for (const accept of [JSON_ACCEPT, FORM_ACCEPT])
      for (const form of [{ action: "priority", priority: "1" }, { action: "drop" }]) {
        const res = await edit(b.url, { ...auth, ...form }, tailnet({ ...accept, ...headers }));
        expect([name, res.status, res.headers.get("content-type")]).toEqual([name, 403, "text/plain; charset=utf-8"]);
      }
  expect(b.store.item("coupas-next")).toMatchObject({ priority: 5, status: "open", decision: "A or B?" });
  expect(b.logs.filter((l) => l.startsWith("BOARD_BACKLOG"))).toEqual([]);
});
