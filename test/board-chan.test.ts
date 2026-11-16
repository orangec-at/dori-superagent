import { expect, test } from "bun:test";
import type { ChannelCopy, ChannelView } from "../src/channel-source.ts";
import { BOT_MACHINE, post, start, tailnet, tokenOf } from "./board-setup.ts";

/** A Discord copy with #dori, #fmv and one DM; every send is recorded and answered with `result`. */
function fakeCopy(result: "sent" | "failed" = "sent") {
  const sends: [string, string][] = [];
  let stamp = 0;
  const view: ChannelView = {
    syncedAt: Date.UTC(2026, 10, 13, 0, 59),
    error: null,
    skipped: [],
    channels: [
      {
        key: "dori",
        name: "dori",
        kind: "channel",
        messages: [
          { at: Date.UTC(2026, 10, 13, 0, 50), author: "Jaeil Lee", mine: true, bot: false, text: "보드 확인" },
        ],
      },
      {
        key: "fmv",
        name: "fmv",
        kind: "channel",
        messages: [
          { at: Date.UTC(2026, 10, 13, 0, 40), author: "도리도라", mine: false, bot: true, text: "vg-umami 올렸어요" },
        ],
      },
      { key: "dm-Jaeil Lee", name: "Jaeil Lee", kind: "dm", messages: [] },
      {
        key: "t-vg",
        name: "vibeguard 승인",
        kind: "thread",
        parent: "fmv",
        archived: false,
        locked: false,
        messages: [{ at: Date.UTC(2026, 10, 13, 0, 45), author: "엔도", mine: false, bot: true, text: "승인 요청" }],
      },
      { key: "t-old", name: "지난 승인", kind: "thread", parent: "fmv", archived: true, locked: true, messages: [] },
    ],
  };
  const discord: ChannelCopy = {
    view: () => view,
    stamp: () => stamp,
    send: async (key, text) => {
      sends.push([key, text]);
      stamp++;
      return result;
    },
  };
  return { discord, sends, bump: () => stamp++ };
}

test("the 채널 tab lists channels and DMs by name; a channel opens with its messages and composer", async () => {
  const { discord } = fakeCopy();
  const b = start({ discord });
  const list = await (await fetch(`${b.url}/?tab=chan`, { headers: tailnet() })).text();
  expect(list).toContain(">#dori<");
  expect(list).toContain(">#fmv<");
  expect(list).toContain(">DM · Jaeil Lee<");
  const chan = await (await fetch(`${b.url}/?tab=chan&d=fmv`, { headers: tailnet() })).text();
  expect(chan).toContain('<body class="has-c">');
  expect(chan).toContain("vg-umami 올렸어요");
  expect(chan).toContain('action="/chan"');
  expect(chan).toContain('name="d" value="fmv"');
  expect(chan).not.toMatch(/\d{17,}/);
});

test("a thread is listed under its parent channel and opens like a channel, posting into the thread", async () => {
  const { discord, sends } = fakeCopy();
  const b = start({ discord });
  const list = await (await fetch(`${b.url}/?tab=chan`, { headers: tailnet() })).text();
  const [fmv = -1, thread = -1, dm = -1] = [">#fmv<", ">vibeguard 승인<", ">DM · Jaeil Lee<"].map((t) =>
    list.indexOf(t),
  );
  expect(fmv).toBeGreaterThan(-1);
  expect(thread).toBeGreaterThan(fmv);
  expect(dm).toBeGreaterThan(thread);
  expect(list).toMatch(/class="row sub"[^>]*href="[^"]*d=t-vg/);
  const pane = await (await fetch(`${b.url}/?tab=chan&d=t-vg`, { headers: tailnet() })).text();
  expect(pane).toContain("#fmv › vibeguard 승인");
  expect(pane).toContain("승인 요청");
  expect(pane).toContain('name="d" value="t-vg"');
  const res = await post(b.url, "/chan", { csrf: await tokenOf(b.url), d: "t-vg", text: "확인" }, tailnet());
  expect(res.headers.get("location")).toBe("/?tab=chan&d=t-vg&sent=chan#end");
  expect(sends).toEqual([["t-vg", "확인"]]);
});

test("a thread post that fails the board's write checks is refused before Discord is called", async () => {
  const { discord, sends } = fakeCopy();
  const b = start({ discord });
  const form = { csrf: await tokenOf(b.url), d: "t-vg", text: "hi" };
  const refused = [
    await post(b.url, "/chan", form, tailnet({ "x-forwarded-for": BOT_MACHINE })),
    await post(b.url, "/chan", form, tailnet({ "tailscale-user-login": "someone@example.com" })),
    await post(b.url, "/chan", { ...form, csrf: "0".repeat(64) }, tailnet()),
  ];
  expect(refused.map((r) => r.status)).toEqual([403, 403, 403]);
  expect(sends).toEqual([]);
});

test("a locked thread shows why it has no composer and refuses a post before Discord is called", async () => {
  const { discord, sends } = fakeCopy();
  const b = start({ discord });
  const pane = await (await fetch(`${b.url}/?tab=chan&d=t-old`, { headers: tailnet() })).text();
  expect(pane).toContain("잠긴 스레드라 보드에서 보낼 수 없어요");
  expect(pane).not.toContain('action="/chan"');
  const res = await post(b.url, "/chan", { csrf: await tokenOf(b.url), d: "t-old", text: "x" }, tailnet());
  expect(res.status).toBe(409);
  expect(sends).toEqual([]);
});

test("the page version follows the Discord copy, so open pages reload when a message arrives", async () => {
  const { discord, bump } = fakeCopy();
  const b = start({ discord });
  const v1 = /name="board-version" content="(\w+)"/.exec(
    await (await fetch(`${b.url}/`, { headers: tailnet() })).text(),
  )?.[1];
  bump();
  const v2 = /name="board-version" content="(\w+)"/.exec(
    await (await fetch(`${b.url}/`, { headers: tailnet() })).text(),
  )?.[1];
  expect(v1).toBeDefined();
  expect(v2).not.toBe(v1);
});

test("an allowed writer's message goes to the channel and returns to it; the lead's conversation is untouched", async () => {
  const { discord, sends } = fakeCopy();
  const b = start({ discord });
  const csrf = await tokenOf(b.url);
  const res = await post(b.url, "/chan", { csrf, d: "dori", text: " 보드에서 인사 " }, tailnet());
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/?tab=chan&d=dori&sent=chan#end");
  expect(sends).toEqual([["dori", "보드에서 인사"]]);
  expect(b.sent).toEqual([]);
  expect(b.logs.some((l) => l.startsWith("BOARD_CHAN discord len=7 sent"))).toBe(true);
});

test("a failed send comes back as a failure notice", async () => {
  const { discord } = fakeCopy("failed");
  const b = start({ discord });
  const res = await post(b.url, "/chan", { csrf: await tokenOf(b.url), d: "dori", text: "x" }, tailnet());
  expect(res.headers.get("location")).toBe("/?tab=chan&d=dori&sent=cfailed#end");
  const page = await (await fetch(`${b.url}${res.headers.get("location")}`, { headers: tailnet() })).text();
  expect(page).toContain("채널로 보내지 못했어요");
});

test("a request that fails the board's write checks is refused before Discord is called", async () => {
  const { discord, sends } = fakeCopy();
  const b = start({ discord });
  const csrf = await tokenOf(b.url);
  const form = { csrf, d: "dori", text: "hi" };
  const refused = [
    await post(b.url, "/chan", form, tailnet({ "x-forwarded-for": BOT_MACHINE })),
    await post(b.url, "/chan", form, tailnet({ "tailscale-user-login": "someone@example.com" })),
    await post(b.url, "/chan", { ...form, csrf: "0".repeat(64) }, tailnet()),
    await post(b.url, "/chan", form, tailnet({ origin: "https://evil.example" })),
    await post(b.url, "/chan", { ...form, d: "secret-channel" }, tailnet()),
    await post(b.url, "/chan", { ...form, text: "  " }, tailnet()),
  ];
  expect(refused.map((r) => r.status)).toEqual([403, 403, 403, 403, 404, 400]);
  expect(sends).toEqual([]);
});

test("without a Discord copy the tab says so and a post is refused", async () => {
  const b = start();
  expect(await (await fetch(`${b.url}/?tab=chan`, { headers: tailnet() })).text()).toContain(
    "이 보드에 연결된 메신저가 없어요",
  );
  const res = await post(b.url, "/chan", { csrf: await tokenOf(b.url), d: "dori", text: "x" }, tailnet());
  expect(res.status).toBe(409);
});

test("a viewer who may not write sees no Discord channel or DM, only why", async () => {
  const { discord } = fakeCopy();
  const b = start({ discord });
  for (const path of ["/?tab=chan", "/?tab=chan&d=fmv", "/?tab=proj&p=vibeguard"]) {
    const html = await (
      await fetch(`${b.url}${path}`, { headers: tailnet({ "x-forwarded-for": BOT_MACHINE }) })
    ).text();
    expect(html).not.toContain("vg-umami 올렸어요");
    expect(html).not.toContain("보드 확인");
    expect(html).not.toContain("승인 요청");
    expect(html).not.toContain("DM · Jaeil Lee");
    expect(html).not.toContain('action="/chan"');
  }
  const list = await (
    await fetch(`${b.url}/?tab=chan`, { headers: tailnet({ "x-forwarded-for": BOT_MACHINE }) })
  ).text();
  expect(list).toContain("채널·DM은 허용된 계정·기기로 열어야 보여요");
});

/** A Slack copy with #vibeguard; sends are recorded. */
function slackCopy() {
  const sends: [string, string][] = [];
  const view: ChannelView = {
    syncedAt: Date.UTC(2026, 10, 13, 0, 58),
    error: null,
    skipped: [],
    channels: [
      {
        key: "sc-vibe",
        name: "vibeguard",
        kind: "channel",
        messages: [{ at: Date.UTC(2026, 10, 13, 0, 30), author: "hermes", mine: false, bot: true, text: "슬랙 소식" }],
      },
    ],
  };
  const slack: ChannelCopy = {
    view: () => view,
    stamp: () => 0,
    send: async (key, text) => {
      sends.push([key, text]);
      return "sent";
    },
  };
  return { source: { id: "slack", label: "Slack", ...slack }, sends };
}

test("the 채널 tab shows Discord and Slack in their own sections; a post goes to the source that lists the channel", async () => {
  const { discord, sends: dsends } = fakeCopy();
  const { source, sends } = slackCopy();
  const b = start({ discord, sources: [source] });
  const list = await (await fetch(`${b.url}/?tab=chan`, { headers: tailnet() })).text();
  const [d = -1, dori = -1, sl = -1, vibe = -1] = [">Discord <", ">#dori<", ">Slack <", ">#vibeguard<"].map((t) =>
    list.indexOf(t),
  );
  expect([d < dori, dori < sl, sl < vibe]).toEqual([true, true, true]);
  expect(list).toContain('<a class="chip" href="#src-slack">Slack 1</a>');
  const pane = await (await fetch(`${b.url}/?tab=chan&d=sc-vibe`, { headers: tailnet() })).text();
  expect(pane).toContain("슬랙 소식");
  expect(pane).toContain("Slack · 동기화");
  const res = await post(b.url, "/chan", { csrf: await tokenOf(b.url), d: "sc-vibe", text: "보드에서" }, tailnet());
  expect(res.headers.get("location")).toBe("/?tab=chan&d=sc-vibe&sent=chan#end");
  expect([sends, dsends]).toEqual([[["sc-vibe", "보드에서"]], []]);
  expect(b.logs.some((l) => l.startsWith("BOARD_CHAN slack len=4 sent"))).toBe(true);
});

test("the 프로젝트 tab no longer lists channels; a page opened before the 채널 tab still posts to /discord", async () => {
  const { discord, sends } = fakeCopy();
  const b = start({ discord });
  const list = await (await fetch(`${b.url}/?tab=proj`, { headers: tailnet() })).text();
  expect(list).not.toContain(">#dori<");
  expect(list).not.toContain("DM · Jaeil Lee");
  expect(list).toContain('href="/?tab=chan"');
  const res = await post(b.url, "/discord", { csrf: await tokenOf(b.url), d: "dori", text: "옛 화면" }, tailnet());
  expect(res.headers.get("location")).toBe("/?tab=chan&d=dori&sent=chan#end");
  expect(sends).toEqual([["dori", "옛 화면"]]);
});
