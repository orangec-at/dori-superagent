import { expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatPath, chatTail } from "../src/board-chat.ts";
import { parseAddress, reply } from "../src/reply.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { NOW, post, start, tailnet, tokenOf } from "./board-setup.ts";

const recorder = (code = 0) => {
  const calls: { cmd: string; argv: readonly string[] }[] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push({ cmd, argv });
    return { code, stdout: "", stderr: code ? "discord down" : "" };
  };
  return { calls, exec };
};

test("a board request and the lead's `dori reply board` answer meet in the lead's record, newest last", async () => {
  const { url, home } = start();
  const csrf = await tokenOf(url);
  const res = await post(url, "/request", { csrf, text: "오늘 coupas 판매액?" }, tailnet());
  expect(res.headers.get("location")).toBe("/?c=lead&sent=request#end");
  const before = (await (await fetch(`${url}/api/version`, { headers: tailnet() })).json()) as { v: string };

  expect(parseAddress("board")).toEqual({ kind: "board" });
  const { calls, exec } = recorder();
  expect(await reply(exec, "board", "어제 12건, 3.4만원이에요.", { home, now: () => NOW + 60_000 })).toBeUndefined();
  expect(calls).toEqual([]);
  expect(chatTail(home, 10)).toEqual([
    { at: NOW, from: "operator", text: "오늘 coupas 판매액?", kind: "request", delivery: "DELIVERED" },
    { at: NOW + 60_000, from: "lead", text: "어제 12건, 3.4만원이에요." },
  ]);

  const after = (await (await fetch(`${url}/api/version`, { headers: tailnet() })).json()) as { v: string };
  expect(after.v).not.toBe(before.v);
  const html = await (await fetch(`${url}/?c=lead`, { headers: tailnet() })).text();
  const me = html.indexOf('<div class="bubble">오늘 coupas 판매액?</div>');
  const them = html.indexOf('<div class="text">어제 12건, 3.4만원이에요.</div>');
  expect(me).toBeGreaterThan(0);
  expect(them).toBeGreaterThan(me);
  expect(html).toContain("전달됨");
  expect(html).toContain('<body class="has-c">');
});

test("board.json copyTo also sends the answer there; a failed copy keeps the board message and is reported", async () => {
  const { home } = start();
  writeFileSync(join(home, "board.json"), JSON.stringify({ copyTo: "discord:42" }));
  const ok = recorder();
  expect(await reply(ok.exec, "board", "답", { home, now: () => NOW })).toBeUndefined();
  expect(ok.calls).toEqual([{ cmd: join(home, "bin", "dori-reply"), argv: ["42", "답"] }]);
  const down = recorder(1);
  const note = await reply(down.exec, "board", "두 번째 답", { home, now: () => NOW });
  expect(note).toStartWith("COPY_FAILED discord:42: REPLY_FAILED discord:42");
  expect(chatTail(home, 10).map((m) => m.text)).toEqual(["답", "두 번째 답"]);
  await expect(reply(ok.exec, "board", "x", { home, files: ["a.png"] })).rejects.toThrow("takes text only");
  await expect(reply(ok.exec, "board", "  ", { home })).rejects.toThrow("the reply is empty");
});

test("a torn or foreign line in the chat file is skipped and the page still renders", async () => {
  const { url, home } = start();
  appendFileSync(chatPath(home), `{"at":1,"from":"lead","text":"하나"}\nnot json\n{"at":2,"from":"bot","text":"x"}\n`);
  expect(chatTail(home, 10).map((m) => m.text)).toEqual(["하나"]);
  expect((await fetch(`${url}/?c=lead`, { headers: tailnet() })).status).toBe(200);
});

test("the polling script is served from the board itself and the version is readable without a login", async () => {
  const { url } = start();
  const js = await fetch(`${url}/board.js`, { headers: tailnet() });
  expect(js.headers.get("content-type")).toStartWith("text/javascript");
  expect(await js.text()).toContain("/api/version");
  const v = await fetch(`${url}/api/version`);
  expect(v.status).toBe(200);
  expect(Object.keys((await v.json()) as object)).toEqual(["v"]);
});
