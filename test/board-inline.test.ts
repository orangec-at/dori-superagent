import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askClose, readAsk } from "../src/asks.ts";
import { PaneGone } from "../src/refusal.ts";
import { post, start, tailnet, tokenOf } from "./board-setup.ts";

const JSON_ACCEPT = { accept: "application/json" };
const FORM_ACCEPT = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const POST_ID = "2026-11-13-1900-drain-strainer";

function postsIn(home: string): void {
  mkdirSync(join(home, "coupas-copy"), { recursive: true });
  writeFileSync(
    join(home, "coupas-copy", "posts.json"),
    readFileSync(join(import.meta.dir, "fixtures", "coupas-posts.json"), "utf8").replaceAll("DORI_HOME", home),
  );
}

type Reply = {
  card: string | null;
  row?: string;
  gone: boolean;
  held: boolean;
  note: string;
  bad: boolean;
  v: string | null;
};

/** The page's csrf token and the version it shows, as board.js reads them. */
async function pageOf(url: string): Promise<{ csrf: string; v: string }> {
  const html = await (await fetch(`${url}/`, { headers: tailnet() })).text();
  return {
    csrf: /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "",
    v: /name="board-version" content="([0-9a-f]+)"/.exec(html)?.[1] ?? "",
  };
}
const decide = async (url: string, form: Record<string, string>): Promise<Reply> =>
  (await (await post(url, "/decide", { id: "vg-analytics", ...form }, tailnet(JSON_ACCEPT))).json()) as Reply;

test("a background /decide gets the card marked sent and the version the next poll answers; a form still gets the redirect", async () => {
  const { url, sent, home } = start();
  const { csrf, v } = await pageOf(url);
  const res = await post(url, "/decide", { csrf, v, id: "vg-analytics", choice: "B" }, tailnet(JSON_ACCEPT));
  expect(res.status).toBe(200);
  const j = (await res.json()) as Reply;
  expect(j.gone).toBe(false);
  expect(j.v).not.toBe(v);
  expect(j.card).toStartWith('<article class="ask" id="ask-vg-analytics">');
  expect(j.card).toContain("보냄: B");
  expect(j.card).toContain(`name="csrf" value="${csrf}"`);
  expect(j).toMatchObject({ note: "결정을 도리도라에게 보냈어요.", bad: false });
  expect(((await (await fetch(`${url}/api/version`)).json()) as { v: string | null }).v).toBe(j.v);
  expect(sent).toEqual(["[reply=board from=재일] decide vg-analytics B"]);
  expect(readAsk(home, "vg-analytics")?.sent?.choice).toBe("B");

  const form = await post(url, "/decide", { csrf, id: "vg-analytics", choice: "A" }, tailnet(FORM_ACCEPT));
  expect(form.status).toBe(303);
  expect(form.headers.get("location")).toBe("/?sent=decide");
  expect(sent).toHaveLength(2);
});

test("a page that missed another change gets no version back: it shows its new pill instead of hiding that change", async () => {
  const { url } = start();
  const { csrf, v } = await pageOf(url);
  const j = await decide(url, { csrf, v: `${v.slice(0, -1)}x`, choice: "A" });
  expect(j.card).toContain("보냄: A");
  expect(j.v).toBeNull();
  expect((await decide(url, { csrf, choice: "B" })).v).toBeNull();
});

test("a background /decide the lead could not take, or that is held, keeps the card and says so", async () => {
  const heldNote = "전달이 확인되지 않았어요. 다시 누르지 말고 lead 화면을 확인해 주세요(dori inbox list lead).";
  for (const [toLead, note, held] of [
    [
      async () => Promise.reject(new Error("no lead pane registered")),
      "도리도라에게 보내지 못했어요. 다시 보내 주세요.",
      false,
    ],
    [async () => "HELD", heldNote, true],
    [async () => Promise.reject(new PaneGone("lead pane gone")), heldNote, true],
  ] as const) {
    const { url, home } = start({ toLead });
    const { csrf, v } = await pageOf(url);
    expect(await decide(url, { csrf, v, choice: "A" })).toMatchObject({
      card: null,
      gone: false,
      held,
      note,
      bad: true,
    });
    expect(readAsk(home, "vg-analytics")?.sent).toBeUndefined();
  }
});

test("a double tap gets the sent card without a second delivery; a closed ask is refused; one closed on the way is gone", async () => {
  const { url, sent, home } = start();
  const { csrf, v } = await pageOf(url);
  await decide(url, { csrf, v, choice: "A" });
  const again = await decide(url, { csrf, v, choice: "A" });
  expect(again.card).toContain("보냄: A");
  expect(sent).toHaveLength(1);

  askClose(home, "vg-analytics", Date.now());
  const closed = await post(url, "/decide", { csrf, v, id: "vg-analytics", choice: "B" }, tailnet(JSON_ACCEPT));
  expect([closed.status, closed.headers.get("content-type")]).toEqual([409, "text/plain; charset=utf-8"]);

  const late = start({
    toLead: async () => {
      askClose(late.home, "vg-analytics", Date.now());
      return "DELIVERED";
    },
  });
  const page = await pageOf(late.url);
  expect(await decide(late.url, { ...page, choice: "B" })).toMatchObject({ card: null, gone: true, bad: false });
});

test("a write that fails the writer, origin or csrf check is refused alike with or without JSON in Accept", async () => {
  const { url, sent, home } = start();
  postsIn(home);
  const csrf = await tokenOf(url);
  const cases: [string, Record<string, string>, Record<string, string>][] = [
    ["another login", { csrf }, { "tailscale-user-login": "someone@example.com" }],
    ["another device", { csrf }, { "x-forwarded-for": "100.64.0.99" }],
    ["other origin", { csrf }, { origin: "https://evil.example" }],
    ["stale csrf", { csrf: "0".repeat(csrf.length) }, {}],
    ["no csrf", {}, {}],
  ];
  for (const [name, auth, headers] of cases)
    for (const accept of [JSON_ACCEPT, FORM_ACCEPT]) {
      const decide = await post(
        url,
        "/decide",
        { ...auth, id: "vg-analytics", choice: "A" },
        tailnet({ ...accept, ...headers }),
      );
      const coupas = await post(
        url,
        "/coupas",
        { ...auth, id: POST_ID, action: "posted" },
        tailnet({ ...accept, ...headers }),
      );
      expect([name, decide.status, decide.headers.get("content-type")]).toEqual([
        name,
        403,
        "text/plain; charset=utf-8",
      ]);
      expect([name, coupas.status]).toEqual([name, 403]);
    }
  expect(sent).toEqual([]);
  expect(readAsk(home, "vg-analytics")?.sent).toBeUndefined();
});

test("a background [올렸음] gets the post's card marked posted; a form still gets the redirect; a bad one is refused", async () => {
  const { url, home } = start();
  postsIn(home);
  const csrf = await tokenOf(url);
  const res = await post(url, "/coupas", { csrf, id: POST_ID, action: "posted" }, tailnet(JSON_ACCEPT));
  expect(res.status).toBe(200);
  const j = (await res.json()) as Reply;
  expect(j.gone).toBe(false);
  expect(j.card).toStartWith(`<article class="cpc" data-post="${POST_ID}">`);
  expect(j.card).toContain('<p class="cps">올렸음 · ');
  expect(j.row).toStartWith(`<div class="cpbr today done" data-post="${POST_ID}">`);
  expect(j.row).toContain('value="undo" aria-label=');
  expect(j.note).toBe("기록했어요.");
  expect(Object.keys(JSON.parse(readFileSync(join(home, "coupas-copy", "posted.json"), "utf8")))).toEqual([POST_ID]);

  const form = await post(url, "/coupas", { csrf, id: POST_ID, action: "undo" }, tailnet(FORM_ACCEPT));
  expect([form.status, form.headers.get("location")]).toEqual([303, `/?tab=coupas&sent=coupas#cp-${POST_ID}`]);
  expect((await post(url, "/coupas", { csrf, id: "nope", action: "posted" }, tailnet(JSON_ACCEPT))).status).toBe(404);
});
