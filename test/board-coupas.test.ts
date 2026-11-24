import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCoupas } from "../src/board-coupas.ts";
import { dayOrder } from "../src/board-coupas-html.ts";
import { HOST, LOGIN, PHONE, post, start, tailnet, tokenOf } from "./board-setup.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "coupas-posts.json"), "utf8");
type Fixture = { posts: { id: string; body: string; reply: string; video: string }[] };

/** The fixture in DORI_HOME/coupas-copy/posts.json, its video paths pointed into this DORI_HOME; returns what was written. */
function postsIn(home: string, edit: (f: Fixture) => void = () => {}): string {
  const f = JSON.parse(FIXTURE.replaceAll("DORI_HOME", home)) as Fixture;
  edit(f);
  mkdirSync(join(home, "coupas-copy"), { recursive: true });
  const text = JSON.stringify(f);
  writeFileSync(join(home, "coupas-copy", "posts.json"), text);
  return text;
}
const videoIn = (home: string, rel: string, bytes = "mp4-bytes"): string => {
  const path = join(home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
};
const page = async (url: string, headers = tailnet()): Promise<string> =>
  (await fetch(`${url}/?tab=coupas`, { headers })).text();
const unesc = (s: string): string =>
  s.replace(
    /&(lt|gt|quot|#39|amp);/g,
    (_, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e] ?? e,
  );
/** What a browser's textarea.value is for each copy box of one card: the parser drops the newline after the tag. */
const boxes = (html: string, id: string): string[] => {
  const card = html.slice(html.indexOf(`id="cp-${id}"`), html.indexOf("</article>", html.indexOf(`id="cp-${id}"`)));
  return [...card.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => unesc(m[1]!).replace(/^\n/, ""));
};

test("the tab shows the cards today first, the text escaped, and every copy box holds the text exactly", async () => {
  const s = start();
  postsIn(s.home, (f) => {
    f.posts[2]!.reply = "\n  앞뒤 공백과 줄바꿈 </textarea><script>alert(1)</script>  \n\n";
  });
  const html = await page(s.url);
  expect(html).toContain('<a class="tab on" href="/?tab=coupas">쿠파스</a>');
  const list = html.slice(0, html.indexOf('<main class="pane">'));
  const days = [...list.matchAll(/<section class="cpx" data-day="([^"]+)">/g)].map((m) => m[1]);
  expect(days).toEqual(["2026-11-13", "2026-11-14", "2026-11-12"]);
  expect(html).toContain("오늘 · 2026-11-13");
  expect(html).toContain("내일 · 2026-11-14");
  expect(html.indexOf('id="cp-2026-11-13-1230-cable-tidy"')).toBeLessThan(
    html.indexOf('id="cp-2026-11-13-1900-drain-strainer"'),
  );
  expect(html).not.toContain("<b>점심</b>");
  expect(html).not.toContain("<script>alert(1)");
  expect(html).toContain("&lt;b&gt;점심&lt;/b&gt;이 따뜻해요 &amp; &quot;진짜&quot;로요 &#39;추천&#39;");
  const f = JSON.parse(FIXTURE) as Fixture;
  expect(boxes(html, "2026-11-13-1900-drain-strainer")).toEqual([f.posts[0]!.body, f.posts[0]!.reply]);
  expect(boxes(html, "2026-11-14-2130-lunch-box")).toEqual([
    f.posts[2]!.body,
    "\n  앞뒤 공백과 줄바꿈 </textarea><script>alert(1)</script>  \n\n",
  ]);
  // No reply: only the body box. No video: no download link and no AI label line.
  expect(boxes(html, "2026-11-13-1230-cable-tidy")).toEqual([f.posts[1]!.body]);
  const cable = html.slice(html.indexOf('id="cp-2026-11-13-1230-cable-tidy"'));
  expect(cable.slice(0, cable.indexOf("</article>"))).not.toContain("영상 받기");
  expect(html).toContain('href="/coupas/video?id=2026-11-13-1900-drain-strainer" download>영상 받기</a>');
  expect(html).toContain("AI 정보 라벨을 켜 주세요.");
  expect(html).toContain('<div class="cpd">');
});

test("no posts.json, or one that is not a post list: the tab says there is nothing to post yet", async () => {
  const s = start();
  expect(await page(s.url)).toContain("아직 올릴 글이 없어요");
  mkdirSync(join(s.home, "coupas-copy"), { recursive: true });
  writeFileSync(join(s.home, "coupas-copy", "posts.json"), "{ broken");
  expect(readCoupas(s.home)).toBeNull();
  expect(await page(s.url)).toContain("아직 올릴 글이 없어요");
  expect(dayOrder(["2026-11-10", "2026-11-15", "2026-11-13", "2026-11-11", "2026-11-14"], "2026-11-13")).toEqual([
    "2026-11-13",
    "2026-11-14",
    "2026-11-15",
    "2026-11-11",
    "2026-11-10",
  ]);
});

test("a writer marks a post as posted, saves its url keeping the time, and undoes it; posts.json is never written", async () => {
  const s = start();
  const posts = postsIn(s.home);
  const id = "2026-11-13-1230-cable-tidy";
  const posted = join(s.home, "coupas-copy", "posted.json");
  const csrf = await tokenOf(s.url);
  const res = await post(s.url, "/coupas", { csrf, id, action: "posted", url: "" }, tailnet());
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`/?tab=coupas&sent=coupas#cp-${id}`);
  const at = new Date(Date.UTC(2026, 10, 13, 1, 0, 0)).toISOString();
  expect(JSON.parse(readFileSync(posted, "utf8"))).toEqual({ [id]: { postedAt: at, url: "" } });
  const url = "https://www.threads.net/@nowon_horse/post/abc";
  await post(s.url, "/coupas", { csrf, id, action: "posted", url }, tailnet());
  expect(JSON.parse(readFileSync(posted, "utf8"))).toEqual({ [id]: { postedAt: at, url } });
  const html = await page(s.url);
  expect(html).toContain('<span class="ast l-working">올렸음</span>');
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain('value="undo">되돌리기</button>');
  await post(s.url, "/coupas", { csrf, id, action: "undo" }, tailnet());
  expect(JSON.parse(readFileSync(posted, "utf8"))).toEqual({});
  expect(readFileSync(join(s.home, "coupas-copy", "posts.json"), "utf8")).toBe(posts);
  for (const [form, status] of [
    [{ id: "nope", action: "posted" }, 404],
    [{ id, action: "delete" }, 400],
    [{ id, action: "posted", url: "javascript:alert(1)" }, 400],
  ] as const)
    expect((await post(s.url, "/coupas", { csrf, ...form }, tailnet())).status).toBe(status);
  expect(JSON.parse(readFileSync(posted, "utf8"))).toEqual({});
});

test("a request that fails the board's write checks is refused and writes nothing", async () => {
  const s = start();
  const posts = postsIn(s.home);
  const csrf = await tokenOf(s.url);
  const form = { csrf, id: "2026-11-13-1230-cable-tidy", action: "posted" };
  const denied: [Record<string, string>, Record<string, string>][] = [
    [form, tailnet({ "tailscale-user-login": "someone@else.com" })],
    [form, tailnet({ "x-forwarded-for": "100.64.0.99" })],
    [form, tailnet({ "x-forwarded-for": `${PHONE}, 100.64.0.99` })],
    [form, tailnet({ origin: "https://evil.example" })],
    [form, tailnet({ "sec-fetch-site": "cross-site" })],
    [{ ...form, csrf: "0".repeat(64) }, tailnet()],
    [form, { host: "127.0.0.1", origin: "https://127.0.0.1", "tailscale-user-login": LOGIN, "x-forwarded-for": PHONE }],
  ];
  for (const [f, h] of denied) expect((await post(s.url, "/coupas", f, h)).status).toBe(403);
  expect((await post(s.url, "/coupas", form, tailnet({ host: "evil.example" }))).status).toBe(403);
  expect(existsSync(join(s.home, "coupas-copy", "posted.json"))).toBe(false);
  expect(readFileSync(join(s.home, "coupas-copy", "posts.json"), "utf8")).toBe(posts);
  expect(s.logs.filter((l) => l.startsWith("BOARD_REJECT")).length).toBe(denied.length + 1);
  // A reader who may not write still sees the cards, with the form disabled.
  const html = await page(s.url, { host: HOST, "x-forwarded-for": PHONE });
  expect(html).toContain("배수구 거름망");
  expect(html).toContain("<fieldset disabled>");
});

test("the video is served by id only, and only from a real path inside DORI_HOME/out/bido-video", async () => {
  const s = start();
  videoIn(s.home, "out/bido-video/drain/final.mp4", "the-video");
  const outside = videoIn(s.home, "elsewhere/secret.mp4", "secret");
  videoIn(s.home, "out/bido-video/notes.txt", "text");
  mkdirSync(join(s.home, "out", "bido-video", "link"), { recursive: true });
  symlinkSync(outside, join(s.home, "out", "bido-video", "link", "final.mp4"));
  postsIn(s.home, (f) => {
    f.posts[1]!.video = outside;
    f.posts[2]!.video = join(s.home, "out", "bido-video", "link", "final.mp4");
    f.posts[3]!.video = join(s.home, "out", "bido-video", "notes.txt");
  });
  const get = (q: string, headers = tailnet()) => fetch(`${s.url}/coupas/video?${q}`, { headers });
  const ok = await get("id=2026-11-13-1900-drain-strainer", { host: HOST });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("video/mp4");
  expect(ok.headers.get("content-disposition")).toBe('attachment; filename="2026-11-13-1900-drain-strainer.mp4"');
  expect(await ok.text()).toBe("the-video");
  for (const q of [
    "id=2026-11-13-1230-cable-tidy",
    "id=2026-11-14-2130-lunch-box",
    "id=2026-11-12-1900-sponge",
    "id=nope",
    `id=${encodeURIComponent(outside)}`,
    "id=../../elsewhere/secret.mp4",
    `path=${encodeURIComponent(outside)}`,
  ]) {
    const res = await get(q);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret");
  }
  expect((await get("id=2026-11-13-1900-drain-strainer", { host: "evil.example" })).status).toBe(403);
});
