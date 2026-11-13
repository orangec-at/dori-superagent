import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { askClose, readAsk } from "../src/asks.ts";
import { boardState } from "../src/board-state.ts";
import { DEFAULT_BOARD, loadBoardConfig } from "../src/board.ts";
import { BOT_MACHINE, CONFIG, NOW, post, start, tailnet, tokenOf } from "./board-setup.ts";

const decide = (choice: string, csrf: string) => ({ csrf, id: "vg-analytics", choice });

test("a HELD delivery is not shown as sent: the card stays unanswered and the operator is told to check", async () => {
  const { url, home, logs } = start({ toLead: async () => "HELD" });
  const res = await post(url, "/decide", decide("A", await tokenOf(url)), tailnet());
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/?sent=held");
  expect(readAsk(home, "vg-analytics")?.sent).toBeUndefined();
  const html = await (await fetch(`${url}/?sent=held`, { headers: tailnet() })).text();
  expect(html).toContain('class="flash bad"');
  expect(html).not.toContain("보냄:");
  expect(logs.at(-1)).toMatch(/^BOARD_WRITE \S+ decide len=\d+ HELD$/);
});

test("a QUEUED delivery is marked sent and says it waits in the lead's inbox", async () => {
  const { url, home } = start({ toLead: async () => "QUEUED" });
  const res = await post(url, "/decide", decide("B", await tokenOf(url)), tailnet());
  expect(res.headers.get("location")).toBe("/?sent=queued");
  expect(readAsk(home, "vg-analytics")?.sent).toEqual({ choice: "B", at: NOW });
});

test("pressing the same choice twice delivers it once; another choice is delivered", async () => {
  const { url, sent, logs } = start();
  const csrf = await tokenOf(url);
  for (const choice of ["A", "A", "B"]) {
    expect((await post(url, "/decide", decide(choice, csrf), tailnet())).status).toBe(303);
  }
  expect(sent).toEqual([
    "[reply=board from=재일] decide vg-analytics A",
    "[reply=board from=재일] decide vg-analytics B",
  ]);
  expect(logs.filter((l) => l.startsWith("BOARD_DUP"))).toHaveLength(1);
});

test("an ask the lead closes while the answer is on its way still answers 303", async () => {
  let home = "";
  const { url, home: h } = start({
    toLead: async () => {
      askClose(home, "vg-analytics", NOW);
      return "DELIVERED";
    },
  });
  home = h;
  const res = await post(url, "/decide", decide("A", await tokenOf(url)), tailnet());
  expect(res.status).toBe(303);
  expect(readAsk(home, "vg-analytics")).toMatchObject({ status: "closed" });
});

test("without board.json nobody can write and requests have no reply address", async () => {
  expect(DEFAULT_BOARD).toEqual({ allow: [], allowNodes: [], replyTo: "", hosts: [] });
  const closed = start({ config: DEFAULT_BOARD });
  expect(await tokenOf(closed.url)).toBe("");
  expect((await post(closed.url, "/request", { csrf: "", text: "x" }, tailnet())).status).toBe(403);
  const noReply = start({ config: { ...CONFIG, replyTo: "" } });
  const res = await post(noReply.url, "/request", { csrf: await tokenOf(noReply.url), text: "x" }, tailnet());
  expect(res.status).toBe(503);
  expect(noReply.sent).toEqual([]);
});

test("board.json is read with its allow list, reply address and extra hosts; bad fields fall back", () => {
  const { home } = start();
  writeFileSync(
    join(home, "board.json"),
    JSON.stringify({
      allow: ["a@example.com", 3],
      allowNodes: ["100.64.0.10"],
      replyTo: "discord:42",
      hosts: ["board.lan"],
    }),
  );
  expect(loadBoardConfig(home)).toEqual({
    allow: ["a@example.com"],
    allowNodes: ["100.64.0.10"],
    replyTo: "discord:42",
    hosts: ["board.lan"],
  });
  writeFileSync(join(home, "board.json"), JSON.stringify({ allow: "x", replyTo: "rm -rf /" }));
  expect(loadBoardConfig(home)).toEqual(DEFAULT_BOARD);
});

test("reads answer only loopback and tailnet hosts; the JSON state needs an allowed login", async () => {
  const { url } = start();
  expect((await fetch(`${url}/`, { headers: { host: "rebind.attacker.example" } })).status).toBe(403);
  expect((await post(url, "/request", { text: "x" }, tailnet({ host: "rebind.attacker.example" }))).status).toBe(403);
  expect((await fetch(`${url}/`)).status).toBe(200);
  expect((await fetch(`${url}/`, { headers: tailnet() })).status).toBe(200);
  expect((await fetch(`${url}/api/board`, { headers: tailnet({ "tailscale-user-login": "" }) })).status).toBe(403);
  expect((await fetch(`${url}/api/board`, { headers: tailnet() })).status).toBe(200);
});

test("a broken projects setting or a corrupt ask file does not take the board down", () => {
  const { home, store } = start();
  writeFileSync(join(home, "board.json"), JSON.stringify({ projects: { x: "vg" } }));
  writeFileSync(join(home, "asks", "broken.json"), "{not json");
  const s = boardState(store, NOW);
  expect(s.asks.map((a) => a.id)).toEqual(["vg-analytics"]);
  writeFileSync(join(home, "board.json"), "{not json");
  expect(boardState(store, NOW).asks).toHaveLength(1);
});

test("the operator's login from a device not on allowNodes cannot write: a bot machine gets 403 and no token", async () => {
  const { url, sent, logs } = start();
  const csrf = await tokenOf(url);
  const fromBot = tailnet({ "x-forwarded-for": BOT_MACHINE });
  const page = await (await fetch(`${url}/`, { headers: fromBot })).text();
  expect(page).toContain("<fieldset disabled>");
  expect(page).not.toMatch(/name="csrf" value="[0-9a-f]+"/);
  const cases: [string, Record<string, string>][] = [
    ["bot machine", fromBot],
    ["no device", tailnet({ "x-forwarded-for": "" })],
    ["chained", tailnet({ "x-forwarded-for": `${BOT_MACHINE}, 100.64.0.10` })],
  ];
  for (const [why, headers] of cases) {
    expect([why, (await post(url, "/decide", decide("A", csrf), headers)).status]).toEqual([why, 403]);
    expect([why, (await post(url, "/request", { csrf, text: "x" }, headers)).status]).toEqual([why, 403]);
  }
  expect(sent).toEqual([]);
  expect(logs.every((l) => l.endsWith(" 403 node"))).toBe(true);
});
