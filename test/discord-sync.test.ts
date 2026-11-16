import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordSync, keyOf } from "../src/discord-sync.ts";
import { maskText } from "../src/discord-text.ts";
import { BASE, DM, DORI, FMV, fakeDiscord, GUILD, ME, msg, ok } from "./discord-fake.ts";

test("mentions, channel links, custom emoji, ids and webhook URLs never reach the page", () => {
  const text = maskText(
    {
      id: "1",
      content: `<@${ME}> see <#${DORI}> <:ok:123456789012345678> thread 1569971812354359407 https://discord.com/api/webhooks/1/abc`,
      mentions: [{ id: ME, username: "jaeil" }],
      attachments: [{ filename: "shot.png" }],
    },
    new Map([[DORI, "dori"]]),
  );
  expect(text).toBe("@jaeil see #dori :ok: thread (ID) (webhook)\n[첨부] shot.png");
});

test("one call per tick: the channel list first, then each channel in turn, asking only for newer messages", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discord-"));
  const d = fakeDiscord({
    ...BASE,
    [`GET /channels/${DORI}/messages?limit=50`]: ok([msg("1002", "둘"), msg("1001", "하나")]),
    [`GET /channels/${FMV}/messages?limit=50`]: ok([
      msg("2001", "fmv 시작", { id: "7", username: "endo", bot: true } as never),
    ]),
    [`GET /channels/${DM}/messages?limit=50`]: ok([]),
    [`GET /channels/${DORI}/messages?limit=50&after=1002`]: ok([msg("1003", "셋")]),
  });
  const s = discordSync(home, d.call, { now: () => 1_000, users: [ME] });
  await s.tick();
  const listed = () => d.calls.filter((c) => !c.path.includes("/threads/"));
  expect(d.calls.map((c) => `${c.method} ${c.path}`)).toContain(`GET /guilds/${GUILD}/threads/active`);
  expect(listed().map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /users/@me/guilds",
    `GET /guilds/${GUILD}/roles`,
    `GET /guilds/${GUILD}/channels`,
    "POST /users/@me/channels",
  ]);
  for (let i = 0; i < 4; i++) await s.tick();
  expect(
    listed()
      .slice(4)
      .map((c) => c.path),
  ).toEqual([
    `/channels/${DORI}/messages?limit=50`,
    `/channels/${FMV}/messages?limit=50`,
    `/channels/${DM}/messages?limit=50`,
    `/channels/${DORI}/messages?limit=50&after=1002`,
  ]);
  const v = s.view();
  expect(v.channels.map((c) => [c.name, c.kind, c.messages.map((m) => m.text)])).toEqual([
    ["dori", "channel", ["하나", "둘", "셋"]],
    ["fmv", "channel", ["fmv 시작"]],
    ["Jaeil Lee", "dm", []],
  ]);
  expect(v.channels[0]!.messages[0]).toMatchObject({ author: "jaeil", mine: true, bot: false });
  expect(v.channels[1]!.messages[0]).toMatchObject({ author: "endo", mine: false, bot: true });
  expect(JSON.stringify(v)).not.toMatch(/\d{17,}/);
  expect(existsSync(join(home, "board", "discord-cache.json"))).toBe(true);
  // A new process starts from the saved copy: the next read asks only for what came after it.
  const again = fakeDiscord({ ...BASE, [`GET /channels/${DORI}/messages?limit=50&after=1003`]: ok([]) });
  const s2 = discordSync(home, again.call, { now: () => 2_000, users: [ME] });
  expect(s2.view().channels[0]!.messages.map((m) => m.text)).toEqual(["하나", "둘", "셋"]);
  await s2.tick();
  await s2.tick();
  expect(again.calls.at(-1)!.path).toBe(`/channels/${DORI}/messages?limit=50&after=1003`);
});

test("a 429 pauses every call for retry_after; a channel the bot may not read is skipped until the next listing", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discord-429-"));
  let now = 0;
  const d = fakeDiscord({
    ...BASE,
    [`GET /channels/${DORI}/messages?limit=50`]: [{ status: 429, body: { retry_after: 30 }, retryAfter: 30 }, ok([])],
    [`GET /channels/${FMV}/messages?limit=50`]: { status: 403, body: null, retryAfter: 0 },
  });
  const s = discordSync(home, d.call, { now: () => now, users: [] });
  await s.tick();
  await s.tick();
  expect(s.view().error).toBe("Discord 429");
  const before = d.calls.length;
  now = 29_000;
  await s.tick();
  expect(d.calls.length).toBe(before);
  now = 31_000;
  await s.tick();
  await s.tick();
  expect(s.view().channels.map((c) => c.name)).toEqual(["dori"]);
  expect(s.view().error).toBeNull();
});

test("a message sent from the board is posted without pings, shown at once, and does not move the read cursor", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discord-send-"));
  const d = fakeDiscord({
    ...BASE,
    [`GET /channels/${DORI}/messages?limit=50`]: ok([msg("1001", "하나")]),
    [`POST /channels/${DORI}/messages`]: ok(
      msg("1500", "**재일 (보드)** 안녕", { id: "5", username: "dori-bot", bot: true } as never),
    ),
    [`GET /channels/${DORI}/messages?limit=50&after=1001`]: ok([
      msg("1400", "그 사이 글"),
      msg("1500", "**재일 (보드)** 안녕"),
    ]),
  });
  const s = discordSync(home, d.call, { now: () => 0, users: [ME] });
  await s.tick();
  await s.tick();
  expect(await s.send(keyOf("channel", DORI), "안녕")).toBe("sent");
  expect(d.calls.at(-1)).toEqual({
    path: `/channels/${DORI}/messages`,
    method: "POST",
    body: { content: "**재일 (보드)** 안녕", allowed_mentions: { parse: [] } },
  });
  expect(s.view().channels[0]!.messages.map((m) => m.text)).toEqual(["하나", "**재일 (보드)** 안녕"]);
  await s.tick();
  await s.tick();
  await s.tick();
  expect(s.view().channels[0]!.messages.map((m) => m.text)).toEqual(["하나", "그 사이 글", "**재일 (보드)** 안녕"]);
  expect(await s.send("nope", "x")).toBe("failed");
});

test("a private channel is not copied; a listing that changed nothing does not reload pages; the cache is owner-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discord-list-"));
  let now = 0;
  const d = fakeDiscord({
    ...BASE,
    [`GET /guilds/${GUILD}/channels`]: ok([
      { id: DORI, name: "dori", type: 0, position: 1 },
      { id: FMV, name: "secret", type: 0, position: 2, permission_overwrites: [{ id: GUILD, deny: "1024" }] },
      {
        id: "900000000000000014",
        name: "open",
        type: 0,
        position: 3,
        permission_overwrites: [{ id: GUILD, deny: "2048" }],
      },
    ]),
  });
  const s = discordSync(home, d.call, { now: () => now, users: [] });
  await s.tick();
  expect(s.view().channels.map((c) => c.name)).toEqual(["dori", "open"]);
  expect(statSync(join(home, "board", "discord-cache.json")).mode & 0o777).toBe(0o600);
  const stamp = s.stamp();
  now = 11 * 60_000;
  await s.tick();
  expect(d.calls.filter((c) => c.path === "/users/@me/guilds").length).toBe(2);
  expect(s.stamp()).toBe(stamp);
});

test("while a 429 pause lasts, a board message is refused without calling Discord", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discord-pause-"));
  const d = fakeDiscord({
    ...BASE,
    [`GET /channels/${DORI}/messages?limit=50`]: { status: 429, body: { retry_after: 30 }, retryAfter: 30 },
  });
  const s = discordSync(home, d.call, { now: () => 1_000, users: [] });
  await s.tick();
  await s.tick();
  const before = d.calls.length;
  expect(await s.send(keyOf("channel", DORI), "hi")).toBe("failed");
  expect(d.calls.length).toBe(before);
});
