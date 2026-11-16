import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { everyoneSees } from "../src/discord-perms.ts";
import { discordSync, keyOf } from "../src/discord-sync.ts";
import { BASE, DM, DORI, FMV, fail, fakeDiscord, GUILD, ME, msg, ok } from "./discord-fake.ts";

const OTHER_USER = "800000000000000002";
const TEN_MIN = 10 * 60_000 + 1;

test("a DM that cannot be opened is skipped and shown; the server's channels and the other DM still sync", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discover-dm-"));
  const lines: string[] = [];
  const d = fakeDiscord({
    ...BASE,
    "POST /users/@me/channels": [fail(403), ok({ id: DM, recipients: [{ username: "endo" }] })],
    [`GET /channels/${DORI}/messages?limit=50`]: ok([msg("1001", "하나")]),
  });
  const s = discordSync(home, d.call, { now: () => 0, users: [ME, OTHER_USER], log: (l) => lines.push(l) });
  await s.tick();
  expect(s.view().channels.map((c) => [c.name, c.kind])).toEqual([
    ["dori", "channel"],
    ["fmv", "channel"],
    ["endo", "dm"],
  ]);
  expect(s.view().skipped).toEqual(["DM (Discord 403)"]);
  expect(s.view().error).toBeNull();
  expect(lines).toEqual(["DISCORD_SKIP DM 403"]);
  await s.tick();
  expect(s.view().channels[0]!.messages.map((m) => m.text)).toEqual(["하나"]);
});

test("a server whose roles or channels cannot be read keeps its copied channels until the next listing works", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discover-guild-"));
  let now = 0;
  const d = fakeDiscord({
    ...BASE,
    [`GET /guilds/${GUILD}/roles`]: [ok([{ id: GUILD, permissions: "1024" }]), fail(500)],
    [`GET /channels/${DORI}/messages?limit=50`]: ok([msg("1001", "하나")]),
  });
  const s = discordSync(home, d.call, { now: () => now, users: [ME] });
  await s.tick();
  await s.tick();
  now = TEN_MIN;
  await s.tick();
  expect(d.calls.filter((c) => c.path === `/guilds/${GUILD}/channels`).length).toBe(1);
  expect(s.view().skipped).toEqual(["서버 (Discord 500)"]);
  expect(s.view().channels.map((c) => c.name)).toEqual(["dori", "fmv", "Jaeil Lee"]);
  expect(s.view().channels[0]!.messages.map((m) => m.text)).toEqual(["하나"]);
});

test("a 429 while listing stops the listing and keeps the old copy", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discover-429-"));
  const d = fakeDiscord({ ...BASE, "POST /users/@me/channels": { status: 429, body: null, retryAfter: 30 } });
  const s = discordSync(home, d.call, { now: () => 0, users: [ME] });
  await s.tick();
  expect(s.view().error).toBe("Discord 429");
  expect(s.view().channels).toEqual([]);
});

test("a channel's key comes from its id: list order and a same-named channel do not move it, and it hides the id", async () => {
  const listed = (order: string[]) =>
    fakeDiscord({
      ...BASE,
      [`GET /guilds/${GUILD}/channels`]: ok(order.map((id, i) => ({ id, name: "dori", type: 0, position: i }))),
    });
  const a = discordSync(mkdtempSync(join(tmpdir(), "dori-key-a-")), listed([DORI, FMV]).call, {
    now: () => 0,
    users: [],
  });
  const b = discordSync(mkdtempSync(join(tmpdir(), "dori-key-b-")), listed([FMV, DORI]).call, {
    now: () => 0,
    users: [],
  });
  await a.tick();
  await b.tick();
  const keys = (s: typeof a) =>
    s
      .view()
      .channels.map((c) => c.key)
      .sort();
  expect(keys(a)).toEqual(keys(b));
  expect(keys(a)).toEqual([keyOf("channel", DORI), keyOf("channel", FMV)].sort());
  expect(keyOf("channel", DORI)).toMatch(/^c-[0-9a-f]{10}$/);
  expect(keyOf("dm", DORI)).toMatch(/^dm-[0-9a-f]{10}$/);
  expect(JSON.stringify(a.view())).not.toContain(DORI);
});

test("a cache written with name keys moves to id keys and keeps its messages and read cursor", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-key-move-"));
  mkdirSync(join(home, "board"), { recursive: true });
  const old = { key: "dori", name: "dori", kind: "channel", id: DORI, after: "1001", denied: false };
  const message = { id: "1001", at: 1, author: "jaeil", mine: true, bot: false, text: "하나" };
  writeFileSync(
    join(home, "board", "discord-cache.json"),
    JSON.stringify({ channels: [{ ...old, messages: [message] }] }),
  );
  const d = fakeDiscord({ ...BASE, [`GET /channels/${DORI}/messages?limit=50&after=1001`]: ok([]) });
  const s = discordSync(home, d.call, { now: () => 0, users: [] });
  expect(s.view().channels.map((c) => [c.key, c.messages.length])).toEqual([[keyOf("channel", DORI), 1]]);
  const saved = JSON.parse(readFileSync(join(home, "board", "discord-cache.json"), "utf8"));
  expect(saved.channels[0].key).toBe(keyOf("channel", DORI));
  await s.tick();
  await s.tick();
  expect(d.calls.at(-1)!.path).toBe(`/channels/${DORI}/messages?limit=50&after=1001`);
});

test("privacy follows the @everyone role's server permissions and the channel's @everyone overwrite", () => {
  const ch = (allow?: string, deny?: string) => ({
    id: DORI,
    name: "x",
    type: 0,
    permission_overwrites: [{ id: GUILD, ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) }],
  });
  const role = (permissions: string) => [
    { id: GUILD, permissions },
    { id: "1", permissions: "1024" },
  ];
  expect(everyoneSees(ch(), GUILD, role("1024"))).toBe(true);
  expect(everyoneSees(ch(undefined, "1024"), GUILD, role("1024"))).toBe(false);
  expect(everyoneSees(ch(), GUILD, role("0"))).toBe(false);
  expect(everyoneSees(ch("1024"), GUILD, role("0"))).toBe(true);
  expect(everyoneSees(ch(undefined, "2048"), GUILD, role("3072"))).toBe(true);
  expect(everyoneSees(ch(undefined, "1024"), GUILD, role("8"))).toBe(true);
  expect(everyoneSees(ch(), GUILD, [{ id: "1", permissions: "1024" }])).toBe(false);
});

test("a server where @everyone cannot view by default copies only the channels that allow it", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-discover-role-"));
  const d = fakeDiscord({
    ...BASE,
    [`GET /guilds/${GUILD}/roles`]: ok([{ id: GUILD, permissions: "0" }]),
    [`GET /guilds/${GUILD}/channels`]: ok([
      { id: DORI, name: "dori", type: 0, position: 1, permission_overwrites: [{ id: GUILD, allow: "1024" }] },
      { id: FMV, name: "staff", type: 0, position: 2 },
    ]),
  });
  const s = discordSync(home, d.call, { now: () => 0, users: [] });
  await s.tick();
  expect(s.view().channels.map((c) => c.name)).toEqual(["dori"]);
});
