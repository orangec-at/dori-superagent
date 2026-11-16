import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackAnswer } from "../src/slack-api.ts";
import { slackSync } from "../src/slack-sync.ts";
import { maskSlack, slackKey } from "../src/slack-text.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ok = (body: Record<string, unknown>): SlackAnswer => ({
  status: 200,
  body: { ok: true, ...body },
  retryAfter: 0,
});
const T0 = 1_794_800_000;

/** A workspace with #vibeguard (one root with replies), the operator's DM and another user's DM; every call is recorded. */
function fakeSlack(over: Record<string, SlackAnswer> = {}) {
  const calls: string[] = [];
  const replies: [string, string, string][] = [];
  const answers: Record<string, SlackAnswer> = {
    "dori.users": ok({ users: ["UOPERATOR1", "UOTHER0001"] }),
    "users.list": ok({
      members: [
        { id: "UOPERATOR1", is_primary_owner: true, profile: { display_name: "재일" } },
        { id: "UOTHER0001", real_name: "누군가" },
      ],
    }),
    "users.conversations": ok({
      channels: [
        { id: "CVIBE00001", name: "vibeguard" },
        { id: "DOPER00001", is_im: true, user: "UOPERATOR1" },
        { id: "DOTHER0001", is_im: true, user: "UOTHER0001" },
      ],
    }),
    "conversations.history": ok({
      messages: [
        { ts: `${T0 + 20}.000100`, user: "UOPERATOR1", text: "배포 언제? <@UOTHER0001> 확인 부탁" },
        {
          ts: `${T0 + 10}.000100`,
          bot_id: "B1",
          bot_profile: { name: "hermes" },
          text: "*승인 요청* PR 올렸어요",
          reply_count: 2,
          latest_reply: `${T0 + 30}.000100`,
        },
        { ts: `${T0 + 5}.000100`, subtype: "channel_join", user: "UOTHER0001", text: "joined" },
      ],
    }),
    "conversations.replies": ok({
      messages: [
        { ts: `${T0 + 10}.000100`, bot_id: "B1", text: "*승인 요청* PR 올렸어요" },
        { ts: `${T0 + 30}.000100`, user: "UOTHER0001", text: "승인했어요 https://hooks.slack.com/services/T/B/x" },
      ],
    }),
    ...over,
  };
  const call = async (method: string, params: Record<string, string> = {}) => {
    calls.push(`${method} ${params["channel"] ?? ""}`.trim());
    return answers[method] ?? ok({});
  };
  const reply = async (channel: string, thread: string, text: string) => {
    replies.push([channel, thread, text]);
    return `${T0 + 40}.000100`;
  };
  return { call, reply, calls, replies, answers };
}

function sync(f: ReturnType<typeof fakeSlack>, now = { t: T0 * 1000 + 60_000 }) {
  const home = mkdtempSync(join(tmpdir(), "dori-slack-"));
  roots.push(home);
  return { s: slackSync(home, f.call, f.reply, { now: () => now.t }), home, now };
}

test("a listing finds the bot's channels and the operator's DM only (an allowed coworker is not the operator); ticks then read each channel and its threads", async () => {
  const f = fakeSlack();
  const { s, home } = sync(f);
  await s.tick();
  expect(s.view().channels.map((c) => [c.name, c.kind])).toEqual([
    ["vibeguard", "channel"],
    ["재일", "dm"],
  ]);
  await s.tick();
  await s.tick();
  await s.tick();
  const v = s.view();
  const chan = v.channels.find((c) => c.name === "vibeguard")!;
  const thread = v.channels.find((c) => c.kind === "thread")!;
  expect(chan.messages.map((m) => m.text)).toEqual(["*승인 요청* PR 올렸어요", "배포 언제? @누군가 확인 부탁"]);
  expect(chan.messages[1]!.mine).toBe(true);
  expect(thread.messages.at(-1)!.mine).toBe(false);
  expect(thread).toMatchObject({ name: "승인 요청 PR 올렸어요", parent: chan.key });
  expect(thread.messages.at(-1)!.text).toBe("승인했어요 (webhook)");
  expect(JSON.stringify(v)).not.toMatch(/CVIBE|DOPER|UOPER|UOTHER/);
  expect(statSync(join(home, "board", "slack-cache.json")).mode & 0o777).toBe(0o600);
  // A thread whose copy has its newest reply is not asked again until the channel says it got another.
  const before = f.calls.length;
  await s.tick();
  await s.tick();
  expect(f.calls.slice(before).every((c) => !c.startsWith("conversations.replies"))).toBe(true);
});

test("a 429 pauses every Slack call for its Retry-After", async () => {
  const f = fakeSlack({ "users.list": { status: 429, body: null, retryAfter: 30 } });
  const { s, now } = sync(f);
  await s.tick();
  expect(s.view().error).toBe("Slack 429");
  const n = f.calls.length;
  now.t += 10_000;
  await s.tick();
  expect(f.calls.length).toBe(n);
  f.answers["users.list"] = ok({ members: [] });
  now.t += 55_000; // a listing that failed is retried a minute after it started
  await s.tick();
  expect(f.calls.length).toBeGreaterThan(n);
  expect(s.view().error).toBeNull();
});

test("a send goes through dori-slack-reply into the thread and shows as the operator's", async () => {
  const f = fakeSlack();
  const { s } = sync(f);
  for (let i = 0; i < 3; i++) await s.tick();
  const thread = s.view().channels.find((c) => c.kind === "thread")!;
  expect(await s.send(thread.key, "확인")).toBe("sent");
  expect(f.replies).toEqual([["CVIBE00001", `${T0 + 10}.000100`, "*재일 (보드)* 확인"]]);
  expect(
    s
      .view()
      .channels.find((c) => c.key === thread.key)!
      .messages.at(-1),
  ).toMatchObject({ mine: true });
  expect(await s.send(slackKey("channel", "CUNKNOWN01"), "x")).toBe("failed");
});

test("a channel the bot was removed from is left out without stopping the others", async () => {
  const f = fakeSlack({
    "conversations.history": { status: 200, body: { ok: false, error: "not_in_channel" }, retryAfter: 0 },
  });
  const { s } = sync(f);
  await s.tick();
  await s.tick();
  expect(s.view().channels.map((c) => c.name)).toEqual(["재일"]);
  expect(s.view().error).toBeNull();
});

test("message text masks ids, tokens and webhooks and keeps link labels", () => {
  const users = new Map([["UOPERATOR1", "재일"]]);
  const t = maskSlack(
    {
      ts: "1",
      text: "<@UOPERATOR1> <#CVIBE00001|vibeguard> <https://x.dev|문서> xoxb-123-abc DEPLOYMENT C0A1B2C3D4 &lt;b&gt;",
    },
    users,
  );
  expect(t).toBe("@재일 #vibeguard 문서 (https://x.dev) (token) DEPLOYMENT (ID) <b>");
});
