import { expect, test } from "bun:test";
import { readAsk } from "../src/asks.ts";
import { serveBoard } from "../src/board.ts";
import { Refusal } from "../src/refusal.ts";
import { CONFIG, HOST, NOW, post, start, tailnet, tokenOf } from "./board-setup.ts";

test("the first screen lists open asks with the recommendation in bold and escapes their text", async () => {
  const { url } = start();
  const res = await fetch(`${url}/`, { headers: tailnet() });
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  const html = await res.text();
  expect(html.indexOf("재일 님 차례")).toBeLessThan(html.indexOf("요청 보내기"));
  expect(html).toContain("<b>A. Umami &lt;b&gt;무료&lt;/b&gt; (추천)</b>");
  expect(html).toContain('value="A">추천대로 (A)</button>');
  expect(html).not.toMatch(/<script\b/);
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  const anon = await (await fetch(`${url}/`)).text();
  expect(anon).toContain("<fieldset disabled>");
  expect(anon).not.toMatch(/name="csrf" value="[0-9a-f]+"/);
});

test("a decision button sends the decide envelope to the lead and marks the card sent", async () => {
  const { url, sent, logs, home } = start();
  const csrf = await tokenOf(url);
  const res = await post(url, "/decide", { csrf, id: "vg-analytics", choice: "A" }, tailnet());
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/?sent=decide");
  expect(sent).toEqual(["[reply=board from=재일] decide vg-analytics A"]);
  expect(readAsk(home, "vg-analytics")?.sent).toEqual({ choice: "A", at: NOW });
  expect(await (await fetch(`${url}/?sent=decide`, { headers: tailnet() })).text()).toContain("보냄: A");
  expect(logs).toEqual([`BOARD_WRITE ${new Date(NOW).toISOString()} decide len=${sent[0]!.length} DELIVERED`]);
  expect((await post(url, "/decide", { csrf, id: "vg-analytics", choice: "Z" }, tailnet())).status).toBe(409);
  expect((await post(url, "/decide", { csrf, id: "nope-id", choice: "A" }, tailnet())).status).toBe(409);
  expect(sent).toHaveLength(1);
});

test("a request goes to the lead with the Discord reply address; text is capped and only lengths are logged", async () => {
  const { url, sent, logs } = start();
  const csrf = await tokenOf(url);
  const res = await post(url, "/request", { csrf, text: "  coupas 오늘 판매액 알려줘  " }, tailnet());
  expect(res.status).toBe(303);
  expect(sent).toEqual(["[reply=discord:100200300 from=재일-board] coupas 오늘 판매액 알려줘"]);
  expect((await post(url, "/request", { csrf, text: "   " }, tailnet())).status).toBe(400);
  expect((await post(url, "/request", { csrf, text: "x".repeat(2001) }, tailnet())).status).toBe(413);
  expect((await post(url, "/request", { csrf, text: "y".repeat(9000) }, tailnet())).status).toBe(413);
  expect(sent).toHaveLength(1);
  expect(logs.join("\n")).not.toContain("coupas");
});

test("writes are refused without an allowed login, through 127.0.0.1, cross-origin or without the token", async () => {
  const { url, sent, logs } = start();
  const csrf = await tokenOf(url);
  const form = { csrf, text: "do it" };
  const cases: [string, Record<string, string>][] = [
    ["no login header", tailnet({ "tailscale-user-login": "" })],
    ["another login", tailnet({ "tailscale-user-login": "someone@example.com" })],
    ["straight to loopback", tailnet({ host: "127.0.0.1:7401", origin: "https://127.0.0.1:7401" })],
    ["localhost", tailnet({ host: "localhost:7401", origin: "https://localhost:7401" })],
    ["no origin", tailnet({ origin: "" })],
    ["other origin", tailnet({ origin: "https://evil.example" })],
    ["http origin", tailnet({ origin: `http://${HOST}` })],
    ["cross-site fetch", tailnet({ "sec-fetch-site": "cross-site" })],
  ];
  for (const [why, headers] of cases)
    expect([why, (await post(url, "/request", form, headers)).status]).toEqual([why, 403]);
  expect((await post(url, "/request", { ...form, csrf: "0".repeat(64) }, tailnet())).status).toBe(403);
  expect((await post(url, "/request", { text: "do it" }, tailnet())).status).toBe(403);
  const json = await fetch(`${url}/request`, {
    method: "POST",
    headers: { ...tailnet(), "content-type": "application/json" },
    body: JSON.stringify(form),
  });
  expect(json.status).toBe(415);
  expect(sent).toEqual([]);
  expect(logs.filter((l) => l.includes(" 403 ")).map((l) => l.split(" ").at(-1))).toEqual([
    "login",
    "login",
    "loopback",
    "loopback",
    "origin",
    "origin",
    "origin",
    "site",
    "csrf",
    "csrf",
  ]);
});

test("a lead that cannot be reached is a 502 and the ask stays unanswered", async () => {
  const { url, home } = start({
    toLead: async () => {
      throw new Refusal("pane w3:p1 is gone");
    },
  });
  const csrf = await tokenOf(url);
  const res = await post(url, "/decide", { csrf, id: "vg-analytics", choice: "B" }, tailnet());
  expect(res.status).toBe(502);
  expect(readAsk(home, "vg-analytics")?.sent).toBeUndefined();
});

test("the board serves the web app manifest and its icons, and only listens on loopback", async () => {
  const { url, store } = start();
  const manifest = (await (await fetch(`${url}/manifest.webmanifest`, { headers: tailnet() })).json()) as {
    display: string;
    icons: unknown[];
  };
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons).toHaveLength(2);
  for (const icon of ["/icon-180.png", "/icon-192.png", "/icon-512.png"]) {
    const res = await fetch(`${url}${icon}`, { headers: tailnet() });
    expect([icon, res.status, res.headers.get("content-type")]).toEqual([icon, 200, "image/png"]);
  }
  expect((await fetch(`${url}/nope`, { headers: tailnet() })).status).toBe(404);
  expect((await fetch(`${url}/`, { method: "PUT", headers: tailnet() })).status).toBe(405);
  expect(() =>
    serveBoard(store, {
      host: "0.0.0.0",
      port: 0,
      now: () => NOW,
      config: CONFIG,
      toLead: async () => "DELIVERED",
    }),
  ).toThrow("loopback only");
});
