import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { post, start, tailnet, tokenOf } from "./board-setup.ts";

const json = tailnet({ accept: "application/json" });
const fileOf = (home: string, id: string) => JSON.parse(readFileSync(join(home, "sheets", `${id}.json`), "utf8"));
const SID1 = "1111111111111111";
const SID2 = "2222222222222222";
const SID3 = "3333333333333333";
const SID4 = "4444444444444444";

async function made(s: ReturnType<typeof start>): Promise<{ id: string; csrf: string }> {
  const csrf = await tokenOf(s.url);
  const res = await post(s.url, "/sheets", { csrf, action: "new", name: "가계부" }, tailnet());
  return { id: /s=([a-z0-9-]+)$/.exec(res.headers.get("location") ?? "")?.[1] ?? "", csrf };
}

test("a save whose answer was lost does not make the next save from the same page a 409", async () => {
  const s = start();
  const { id, csrf } = await made(s);
  const save = (rev: string, sid: string, lost: string, name: string) =>
    post(s.url, "/sheets", { csrf, action: "save", id, rev, sid, lost, snapshot: JSON.stringify({ name }) }, json);
  // Written on the board, but the page never got the answer: it still holds rev 1 and names SID1 as lost.
  expect((await save("1", SID1, "", "하나")).status).toBe(200);
  expect(fileOf(s.home, id).sid).toBe(SID1);
  // The next save's answer was lost too (written as rev 3), and so was one that never reached the board (SID3).
  const again = await save("1", SID2, SID1, "둘");
  expect(await again.json()).toEqual({ rev: 3, savedAt: expect.any(String) });
  const third = await save("1", SID4, `${SID1},${SID2},${SID3}`, "셋");
  expect(third.status).toBe(200);
  expect(fileOf(s.home, id)).toMatchObject({ rev: 4, sid: SID4, snapshot: { name: "셋" } });
  expect(s.logs.filter((l) => l.endsWith(" resumed")).length).toBe(2);
  // A second device still on rev 1, or naming a save that is not the file's last one: refused, nothing written.
  expect((await save("1", "6666666666666666", "", "덮어쓰기")).status).toBe(409);
  expect((await save("2", "6666666666666666", SID1, "덮어쓰기")).status).toBe(409);
  expect(fileOf(s.home, id).snapshot).toEqual({ name: "셋" });
  // The page that answered rev 4 goes on as usual.
  expect((await save("4", "5555555555555555", "", "넷")).status).toBe(200);
  expect(fileOf(s.home, id).rev).toBe(5);
});

test("a client log is one line in the board's log, checked like any write, and carries no sheet content", async () => {
  const s = start();
  const { id, csrf } = await made(s);
  const log = { csrf, action: "clientlog", id, kind: "keepalive", status: "0", vw: "412", hidden: "1" };
  const message = `TypeError: Failed\u2028to\u202efetch vw=1 hidden=false\n${"x".repeat(300)}`;
  const ok = await post(s.url, "/sheets", { ...log, message }, tailnet());
  expect(ok.status).toBe(204);
  const lines = s.logs.filter((l) => l.startsWith("BOARD_SHEET_CLIENT"));
  expect(lines).toEqual([
    `BOARD_SHEET_CLIENT ${id} keepalive 0 ${JSON.stringify(`TypeError: Failed to fetch vw=1 hidden=false ${"x".repeat(300)}`.slice(0, 200))} vw=412 hidden=true`,
  ]);
  for (const [form, status] of [
    [{ ...log, kind: "snapshot" }, 400],
    [{ ...log, status: "-1" }, 400],
    [{ ...log, vw: "wide" }, 400],
    [{ ...log, hidden: "yes" }, 400],
    [{ ...log, id: "../board" }, 400],
    [{ ...log, id: "2026-01-01-00000000" }, 404],
    [{ ...log, message: "x".repeat(3000) }, 413],
  ] as const)
    expect((await post(s.url, "/sheets", form, tailnet())).status).toBe(status);
  // Not allowed to write: refused before anything is logged as the client's.
  for (const h of [
    tailnet({ "tailscale-user-login": "someone@else.com" }),
    tailnet({ origin: "https://evil.example" }),
  ])
    expect((await post(s.url, "/sheets", log, h)).status).toBe(403);
  expect((await post(s.url, "/sheets", { ...log, csrf: "0".repeat(64) }, tailnet())).status).toBe(403);
  expect(s.logs.filter((l) => l.startsWith("BOARD_SHEET_CLIENT")).length).toBe(1);
  expect(s.logs.filter((l) => l.startsWith("BOARD_REJECT")).length).toBe(10);
  expect(fileOf(s.home, id).rev).toBe(1);
  // An error on the page, the touch fix the editor applied and its opening are logged the same way.
  for (const kind of ["error", "touch", "open"])
    expect((await post(s.url, "/sheets", { ...log, kind, message: "m" }, tailnet())).status).toBe(204);
  expect(s.logs.filter((l) => l.startsWith("BOARD_SHEET_CLIENT")).slice(1)).toEqual([
    `BOARD_SHEET_CLIENT ${id} error 0 "m" vw=412 hidden=true`,
    `BOARD_SHEET_CLIENT ${id} touch 0 "m" vw=412 hidden=true`,
    `BOARD_SHEET_CLIENT ${id} open 0 "m" vw=412 hidden=true`,
  ]);
});

test("only the open sheet's page keeps pinch zoom from scaling the whole screen", async () => {
  const s = start();
  const { id } = await made(s);
  const html = async (q: string) => (await fetch(`${s.url}/${q}`, { headers: tailnet() })).text();
  expect(await html(`?tab=sheets&s=${id}`)).toContain("initial-scale=1, maximum-scale=1, user-scalable=no,");
  expect(await html("")).not.toContain("user-scalable=no");
});
