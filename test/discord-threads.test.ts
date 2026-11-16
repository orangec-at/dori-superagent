import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordSync, keyOf } from "../src/discord-sync.ts";
import { ARCHIVED_MAX } from "../src/discord-threads.ts";
import { BASE, DORI, FMV, fail, fakeDiscord, GUILD, ME, msg, ok } from "./discord-fake.ts";

const VG = "900000000000000201";
const SECRET = "900000000000000202";
const PRIV = "900000000000000203";
const thread = (id: string, parent: string, type = 11, last = id) => ({
  id,
  name: `t-${id.slice(-3)}`,
  type,
  parent_id: parent,
  last_message_id: last,
});
/** Seven archived threads per channel, ids 3xx under #dori and 4xx under #fmv: #fmv's are newer. */
const old = (parent: string, base: number) =>
  ok({ threads: Array.from({ length: 7 }, (_, i) => thread(`9000000000000${base + i}`, parent)), has_more: false });

const routes = () => ({
  ...BASE,
  [`GET /guilds/${GUILD}/threads/active`]: ok({
    threads: [
      thread(VG, FMV, 11, "900000000000000990"),
      thread(PRIV, DORI, 12, "900000000000000980"),
      thread(SECRET, "900000000000000013"),
    ],
  }),
  [`GET /channels/${DORI}/threads/archived/public`]: old(DORI, 300),
  [`GET /channels/${DORI}/threads/archived/private`]: fail(403),
  [`GET /channels/${FMV}/threads/archived/public`]: old(FMV, 400),
});

test("threads are listed under their copied parent: active first, then the newest archived up to the cap", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-"));
  writeFileSync(join(home, "projects.json"), JSON.stringify({ alias: { [VG]: "vibeguard" } }));
  const d = fakeDiscord(routes());
  const s = discordSync(home, d.call, { now: () => 0, users: [] });
  await s.tick();
  // A private archived listing refused for lack of Manage Threads is not asked again for the next channel.
  expect(d.calls.map((c) => c.path).filter((p) => p.includes("/threads/"))).toEqual([
    `/guilds/${GUILD}/threads/active`,
    `/channels/${DORI}/threads/archived/public?limit=5`,
    `/channels/${DORI}/threads/archived/private?limit=5`,
    `/channels/${FMV}/threads/archived/public?limit=5`,
  ]);
  const v = s.view();
  const threads = v.channels.filter((c) => c.kind === "thread");
  expect(threads.slice(0, 2)).toMatchObject([
    { key: keyOf("thread", VG), parent: keyOf("channel", FMV), private: false, archived: false, project: "vibeguard" },
    { key: keyOf("thread", PRIV), parent: keyOf("channel", DORI), private: true, archived: false },
  ]);
  expect(threads.some((c) => c.key === keyOf("thread", SECRET))).toBe(false);
  const archived = threads.filter((c) => c.archived);
  expect(archived.length).toBe(ARCHIVED_MAX);
  expect(archived.slice(0, 7).every((c) => c.parent === keyOf("channel", FMV))).toBe(true);
  expect(archived.at(-1)!.key).toBe(keyOf("thread", "9000000000000304"));
  expect(JSON.stringify(v)).not.toMatch(/\d{17,}/);
});

test("a thread's messages are read and a board message is posted into the thread itself", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-send-"));
  const d = fakeDiscord({
    ...routes(),
    [`GET /channels/${VG}/messages?limit=50`]: ok([msg("1001", "승인할게요")]),
    [`GET /channels/${VG}/messages`]: ok([]),
    [`POST /channels/${VG}/messages`]: ok(msg("1002", "**재일 (보드)** 확인", { id: "5", username: "bot" })),
  });
  const s = discordSync(home, d.call, { now: () => 0, users: [ME] });
  await s.tick();
  const order = s.view().channels.filter((c) => c.kind !== "dm");
  for (let i = 0; i < order.length; i++) await s.tick();
  const key = keyOf("thread", VG);
  expect(
    s
      .view()
      .channels.find((c) => c.key === key)!
      .messages.map((m) => m.text),
  ).toEqual(["승인할게요"]);
  expect(await s.send(key, "확인")).toBe("sent");
  expect(d.calls.at(-1)).toMatchObject({ path: `/channels/${VG}/messages`, method: "POST" });
});

test("a failed thread listing keeps the threads already copied; a 429 ends the listing without dropping them", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-fail-"));
  let now = 0;
  const first = fakeDiscord(routes());
  await discordSync(home, first.call, { now: () => now, users: [] }).tick();
  const failing = fakeDiscord({ ...routes(), [`GET /guilds/${GUILD}/threads/active`]: fail(500) });
  const s = discordSync(home, failing.call, { now: () => now, users: [] });
  await s.tick();
  expect(s.view().channels.some((c) => c.key === keyOf("thread", VG))).toBe(true);
  now = 11 * 60_000;
  const limited = fakeDiscord({
    ...routes(),
    [`GET /guilds/${GUILD}/threads/active`]: { status: 429, body: { retry_after: 5 }, retryAfter: 5 },
  });
  const s2 = discordSync(home, limited.call, { now: () => now, users: [] });
  await s2.tick();
  expect(s2.view().error).toBe("Discord 429");
  expect(s2.view().channels.some((c) => c.key === keyOf("thread", VG))).toBe(true);
});
