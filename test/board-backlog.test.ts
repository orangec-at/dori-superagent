import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../src/store.ts";
import type { Item } from "../src/store-types.ts";
import { BOT_MACHINE, NOW, post, start, tailnet, tokenOf } from "./board-setup.ts";

const CWD = "/home/b/workspace/coupas";
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

/** A board whose coupas project (board.json word) has one open and one running item. */
function board() {
  const b = start();
  writeFileSync(join(b.home, "board.json"), JSON.stringify({ projects: { coupas: { words: ["coupas"] } } }));
  writeFileSync(join(b.home, "brief.md"), "# brief\n");
  b.store.saveItem({ ...item("coupas-next"), brief: join(b.home, "brief.md") });
  b.store.saveItem(item("coupas-live", { status: "running" }));
  return b;
}
const send = async (url: string, form: Record<string, string>, headers = tailnet()) =>
  post(url, "/backlog", { csrf: await tokenOf(url), p: "coupas", ...form }, headers);
const statusOf = (store: Store, id: string) => store.item(id)?.status;

test("a writer adds a task: it lands in the project's backlog and the page returns to its tasks", async () => {
  const b = board();
  const res = await send(b.url, { action: "add", title: "가격표 정리", priority: "2", text: "세부 설명" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/?tab=proj&p=coupas&sent=backlog#tasks");
  const added = b.store.items().find((i) => i.title === "가격표 정리")!;
  expect(added).toMatchObject({ priority: 2, cwd: CWD, source: "board", status: "open" });
  expect(added.id).toStartWith("coupas-");
  const html = await (await fetch(`${b.url}${res.headers.get("location")}`, { headers: tailnet() })).text();
  expect(html).toContain("가격표 정리");
  expect(html).toContain("백로그에 반영했어요.");
  expect(b.logs.some((l) => l === `BOARD_BACKLOG add ${added.id}`)).toBe(true);
});

test("priority, decision and drop go through the backlog functions", async () => {
  const b = board();
  b.store.saveItem({ ...b.store.item("coupas-next")!, decision: "A or B?" });
  expect((await send(b.url, { action: "priority", id: "coupas-next", priority: "1" })).status).toBe(303);
  expect(b.store.item("coupas-next")).toMatchObject({ priority: 1 });
  expect(b.store.item("coupas-next")!.log.at(-1)).toMatchObject({ kind: "priority", text: "p5 -> p1" });
  expect((await send(b.url, { action: "decide", id: "coupas-next", text: "A" })).status).toBe(303);
  expect(b.store.item("coupas-next")!.decision).toBeUndefined();
  expect((await send(b.url, { action: "drop", id: "coupas-next" })).status).toBe(303);
  expect(statusOf(b.store, "coupas-next")).toBe("dropped");
});

test("edits the backlog refuses answer 409 and change nothing", async () => {
  const b = board();
  const live = await send(b.url, { action: "priority", id: "coupas-live", priority: "1" });
  expect(live.status).toBe(409);
  expect(await live.text()).toContain("not open");
  expect((await send(b.url, { action: "drop", id: "coupas-live" })).status).toBe(409);
  expect(statusOf(b.store, "coupas-live")).toBe("running");
  expect((await send(b.url, { action: "priority", id: "nope", priority: "1" })).status).toBe(409);
  expect((await send(b.url, { action: "add", title: "x", p: "없는 프로젝트" })).status).toBe(409);
  expect((await send(b.url, { action: "add", title: "  " })).status).toBe(400);
  expect((await send(b.url, { action: "rm", id: "coupas-next" })).status).toBe(400);
});

test("a request that fails the board's write checks never touches the backlog", async () => {
  const b = board();
  const form = { action: "drop", id: "coupas-next" };
  const refused = [
    await send(b.url, form, tailnet({ "x-forwarded-for": BOT_MACHINE })),
    await send(b.url, form, tailnet({ "tailscale-user-login": "someone@example.com" })),
    await send(b.url, form, tailnet({ origin: "https://evil.example" })),
    await post(b.url, "/backlog", { ...form, p: "coupas", csrf: "0".repeat(64) }, tailnet()),
  ];
  expect(refused.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  expect(statusOf(b.store, "coupas-next")).toBe("open");
});
