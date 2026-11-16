import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordSync, keyOf } from "../src/discord-sync.ts";
import { ARCHIVED_MAX } from "../src/discord-threads.ts";
import { BASE, DORI, FMV, fail, fakeDiscord, GUILD, ME, msg, ok } from "./discord-fake.ts";

const VG = "900000000000000201";
const SECRET = "900000000000000202";
const PRIV = "900000000000000203";
const thread = (id: string, parent: string, o: { type?: number; last?: string; locked?: boolean } = {}) => ({
  id,
  name: `t-${id.slice(-3)}`,
  type: o.type ?? 11,
  parent_id: parent,
  last_message_id: o.last ?? id,
  thread_metadata: { locked: o.locked === true },
});
/** Seven archived threads per channel, ids …3xx under #dori and …4xx under #fmv: #fmv's are newer. */
const old = (parent: string, base: number) =>
  ok({ threads: Array.from({ length: 7 }, (_, i) => thread(`9000000000000${base + i}`, parent, { locked: i === 6 })) });

const routes = () => ({
  ...BASE,
  [`GET /guilds/${GUILD}/threads/active`]: ok({
    threads: [
      thread(VG, FMV, { last: "900000000000000990" }),
      thread(PRIV, DORI, { type: 12, last: "900000000000000980" }),
      thread(SECRET, "900000000000000013"),
    ],
  }),
  [`GET /channels/${DORI}/threads/archived/public`]: old(DORI, 300),
  [`GET /channels/${FMV}/threads/archived/public`]: old(FMV, 400),
});
const threadsOf = (s: ReturnType<typeof discordSync>) => s.view().channels.filter((c) => c.kind === "thread");

test("public threads sit under their copied parent: active first, then the newest archived up to the cap", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-"));
  writeFileSync(join(home, "projects.json"), JSON.stringify({ alias: { [VG]: "vibeguard" } }));
  const d = fakeDiscord(routes());
  const s = discordSync(home, d.call, { now: () => 0, users: [] });
  await s.tick();
  expect(d.calls.map((c) => c.path).filter((p) => p.includes("/threads/"))).toEqual([
    `/guilds/${GUILD}/threads/active`,
    `/channels/${DORI}/threads/archived/public?limit=5`,
    `/channels/${FMV}/threads/archived/public?limit=5`,
  ]);
  // A private thread is seen by its invitees only: like a private channel, it is never copied.
  expect(threadsOf(s).filter((c) => !c.archived)).toEqual([
    {
      key: keyOf("thread", VG),
      name: "t-201",
      kind: "thread",
      parent: keyOf("channel", FMV),
      archived: false,
      locked: false,
      project: "vibeguard",
      messages: [],
    },
  ]);
  const archived = threadsOf(s).filter((c) => c.archived);
  expect(archived.length).toBe(ARCHIVED_MAX);
  expect(archived.slice(0, 7).every((c) => c.parent === keyOf("channel", FMV))).toBe(true);
  expect(archived.at(-1)!.key).toBe(keyOf("thread", "9000000000000304"));
  expect(archived[0]).toMatchObject({ key: keyOf("thread", "9000000000000406"), locked: true });
  expect(d.calls.some((c) => c.path.includes("/archived/private"))).toBe(false);
  expect(JSON.stringify(s.view())).not.toMatch(/\d{17,}/);
});

test("a thread is read and posted to like a channel; an archived one is read once; a locked one refuses a post", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-send-"));
  const OLD = "9000000000000400";
  const d = fakeDiscord({
    ...routes(),
    [`GET /channels/${VG}/messages?limit=50`]: ok([msg("1001", "승인할게요")]),
    [`GET /channels/${VG}/messages`]: ok([]),
    [`GET /channels/${OLD}/messages?limit=50`]: ok([msg("1000", "옛 글")]),
    [`POST /channels/${VG}/messages`]: ok(msg("1002", "**재일 (보드)** 확인", { id: "5", username: "bot" })),
  });
  const s = discordSync(home, d.call, { now: () => 0, users: [ME] });
  for (let i = 0; i < 40; i++) await s.tick();
  const text = (id: string) =>
    s
      .view()
      .channels.find((c) => c.key === keyOf("thread", id))
      ?.messages.map((m) => m.text);
  expect(text(VG)).toEqual(["승인할게요"]);
  expect(text(OLD)).toEqual(["옛 글"]);
  expect(d.calls.filter((c) => c.path.startsWith(`/channels/${OLD}/messages`)).length).toBe(1);
  expect(await s.send(keyOf("thread", VG), "확인")).toBe("sent");
  expect(d.calls.at(-1)).toMatchObject({ path: `/channels/${VG}/messages`, method: "POST" });
  const calls = d.calls.length;
  expect(await s.send(keyOf("thread", "9000000000000406"), "x")).toBe("failed");
  expect(d.calls.length).toBe(calls);
});

test("a failed thread listing is named and keeps the copied threads; a 429 ends the listing without dropping them", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-fail-"));
  let now = 0;
  const first = discordSync(home, fakeDiscord(routes()).call, { now: () => now, users: [] });
  await first.tick();
  const copied = threadsOf(first).map((c) => c.key);
  expect(copied.length).toBe(1 + ARCHIVED_MAX);
  const failing = fakeDiscord({ ...routes(), [`GET /guilds/${GUILD}/threads/active`]: fail(500) });
  const s = discordSync(home, failing.call, { now: () => now, users: [] });
  await s.tick();
  expect(s.view().skipped).toEqual(["스레드 (Discord 500)"]);
  expect(threadsOf(s).map((c) => c.key)).toEqual(copied);
  now = 11 * 60_000;
  const limited = fakeDiscord({
    ...routes(),
    [`GET /guilds/${GUILD}/threads/active`]: { status: 429, body: { retry_after: 5 }, retryAfter: 5 },
  });
  const s2 = discordSync(home, limited.call, { now: () => now, users: [] });
  await s2.tick();
  expect(s2.view().error).toBe("Discord 429");
  expect(threadsOf(s2).map((c) => c.key)).toEqual(copied);
});

test("a 429 on an archived listing stops only those listings and keeps the archived threads already copied", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-arch429-"));
  let now = 0;
  await discordSync(home, fakeDiscord(routes()).call, { now: () => now, users: [] }).tick();
  now = 11 * 60_000;
  const d = fakeDiscord({
    ...routes(),
    [`GET /channels/${DORI}/threads/archived/public`]: { status: 429, body: { retry_after: 5 }, retryAfter: 5 },
  });
  const s = discordSync(home, d.call, { now: () => now, users: [] });
  await s.tick();
  expect(d.calls.some((c) => c.path.startsWith(`/channels/${FMV}/threads/archived`))).toBe(false);
  expect(threadsOf(s).filter((c) => c.archived).length).toBe(ARCHIVED_MAX);
  expect(
    s
      .view()
      .channels.filter((c) => c.kind === "channel")
      .map((c) => c.name),
  ).toEqual(["dori", "fmv"]);
});

test("a copied thread whose parent channel is gone is left out of the view", () => {
  const home = mkdtempSync(join(tmpdir(), "dori-threads-orphan-"));
  mkdirSync(join(home, "board"));
  const kept = { scope: `guild:${GUILD}`, after: null, denied: false, messages: [] };
  const channels = [
    { ...kept, id: DORI, key: keyOf("channel", DORI), name: "dori", kind: "channel" },
    { ...kept, id: VG, key: keyOf("thread", VG), name: "lost", kind: "thread", parent: FMV },
  ];
  writeFileSync(join(home, "board", "discord-cache.json"), JSON.stringify({ channels }));
  const s = discordSync(home, fakeDiscord({}).call, { now: () => 0, users: [] });
  expect(s.view().channels.map((c) => c.name)).toEqual(["dori"]);
});
