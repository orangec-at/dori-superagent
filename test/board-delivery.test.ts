import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { askClose, readAsk } from "../src/asks.ts";
import { boardState } from "../src/board-state.ts";
import { DEFAULT_BOARD, loadBoardConfig } from "../src/board-config.ts";
import { chatTail } from "../src/board-chat.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { World, href } from "./fake.ts";
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

test("without board.json nobody can write, through the tailnet or Cloudflare Access", async () => {
  expect(DEFAULT_BOARD).toEqual({ allow: [], allowNodes: [], access: null, copyTo: "", hosts: [] });
  const closed = start({ config: DEFAULT_BOARD });
  expect(await tokenOf(closed.url)).toBe("");
  expect((await post(closed.url, "/request", { csrf: "", text: "x" }, tailnet())).status).toBe(403);
  const viaTunnel = { host: "localhost", origin: "https://board.example.com", "cf-access-jwt-assertion": "a.b.c" };
  expect((await post(closed.url, "/request", { csrf: "", text: "x" }, viaTunnel)).status).toBe(403);
  expect(closed.sent).toEqual([]);
  expect(CONFIG.access).toBeNull();
});

test("board.json is read with its allow list, reply address and extra hosts; bad fields fall back", () => {
  const { home } = start();
  writeFileSync(
    join(home, "board.json"),
    JSON.stringify({
      allow: ["a@example.com", 3],
      allowNodes: ["100.64.0.10"],
      access: {
        teamDomain: "team.cloudflareaccess.com",
        aud: "a".repeat(64),
        allowEmails: [" Op@Example.com "],
        origin: "https://board.example.com",
      },
      copyTo: "discord:42",
      hosts: ["board.lan"],
    }),
  );
  expect(loadBoardConfig(home)).toEqual({
    allow: ["a@example.com"],
    allowNodes: ["100.64.0.10"],
    access: {
      teamDomain: "team.cloudflareaccess.com",
      aud: "a".repeat(64),
      allowEmails: ["op@example.com"],
      origin: "https://board.example.com",
    },
    copyTo: "discord:42",
    hosts: ["board.lan"],
  });
  const badAccess = [
    { teamDomain: "evil.example.com", aud: "a".repeat(64), allowEmails: ["a@b.c"], origin: "https://x.y" },
    { teamDomain: "t.cloudflareaccess.com", aud: "a".repeat(64), allowEmails: [], origin: "https://x.y" },
    { teamDomain: "t.cloudflareaccess.com", aud: "a".repeat(64), allowEmails: ["a@b.c"], origin: "http://x.y" },
  ];
  for (const access of badAccess) {
    writeFileSync(join(home, "board.json"), JSON.stringify({ access }));
    expect(loadBoardConfig(home).access).toBeNull();
  }
  writeFileSync(join(home, "board.json"), JSON.stringify({ allow: "x", copyTo: "rm -rf /" }));
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

test("a request queued for a busy lead is QUEUED even when the flush after it fails; the duty loop delivers it", async () => {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w3:p1", "working");
  d.store.setRole("lead", href("w3:p1"));
  // 2026-11-16 05:36Z: the message reached the lead's inbox, then a herdr call in the flush failed and the board said 502.
  w.getHook.set("w3:p1", (n) => {
    if (n === 1) throw new Error("herdr timed out");
  });
  const { url, home, logs } = start({ toLead: (text) => send(d, "lead", text, "board") });
  const res = await post(url, "/request", { csrf: await tokenOf(url), text: "(bot:endo) 엔도 깨워봐" }, tailnet());
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/?c=lead&sent=queued#end");
  expect(logs.at(-1)).toMatch(/^BOARD_WRITE \S+ request len=\d+ QUEUED$/);
  expect(chatTail(home, 1)[0]).toMatchObject({ from: "operator", text: "(bot:endo) 엔도 깨워봐", delivery: "QUEUED" });
  expect(d.store.queued(href("w3:p1"))).toHaveLength(1);

  lead.status = "idle";
  await dutyTick(d);
  expect(lead.received).toEqual(["[reply=board from=재일-board] (bot:endo) 엔도 깨워봐"]);
  expect(d.store.queued(href("w3:p1"))).toEqual([]);
});

test("a lead pane found gone after the request was queued is HELD on the board, never offered to send again", async () => {
  const w = new World();
  const d = w.deps();
  d.store.setRole("lead", href("w3:p1"));
  const { url, home, logs } = start({ toLead: (text) => send(d, "lead", text, "board") });
  const res = await post(url, "/request", { csrf: await tokenOf(url), text: "아무도 없어?" }, tailnet());
  expect(res.headers.get("location")).toBe("/?c=lead&sent=held#end");
  expect(logs.at(-2)).toMatch(
    /^BOARD_FAILED \S+ request len=\d+ pane w3:p1 is gone; 1 message\(s\) kept in its inbox$/,
  );
  expect(logs.at(-1)).toMatch(/^BOARD_WRITE \S+ request len=\d+ HELD$/);
  expect(chatTail(home, 1)[0]).toMatchObject({ text: "아무도 없어?", delivery: "HELD" });
  expect(d.store.queued(href("w3:p1"))).toHaveLength(1);
});

test("a request that could not be queued from a lane conversation comes back to that conversation as failed", async () => {
  const { url, store } = start({
    toLead: async () => {
      throw new Error("no lead pane registered");
    },
  });
  store.saveLane({
    key: "fix-x",
    sessionRef: { runtime: "herdr", id: "w1:p2", container: "w1:t9" },
    paneId: "w1:p2",
    tabId: "w1:t9",
    brief: "/dev/null",
    cwd: "/",
    status: "working",
    createdAt: NOW,
    lastActivityAt: NOW,
    nudges: 0,
    log: [],
  });
  const res = await post(url, "/request", { csrf: await tokenOf(url), c: "lane:fix-x", text: "상태?" }, tailnet());
  expect(res.headers.get("location")).toBe("/?c=lane%3Afix-x&sent=failed#end");
});
