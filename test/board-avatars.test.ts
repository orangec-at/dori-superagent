import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgents } from "../src/agents.ts";
import { avatarFile, syncAvatars } from "../src/board-avatars.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { start, tailnet } from "./board-setup.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function home() {
  const s = start();
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify([
      { name: "panbungi", host: "ubuntu", profile: "panbungi", role: "sales", description: "판붕이(ubuntu): 영업" },
      {
        name: "endo",
        host: "",
        profile: "endo",
        role: "review",
        description: "엔도(fedora): 검토",
        avatar: "pics/endo.webp",
      },
      { name: "yoridori", host: "", profile: "yoridori", role: "yoga", description: "요리도리(fedora): 초안" },
    ]),
  );
  mkdirSync(join(s.home, "avatars"), { recursive: true });
  mkdirSync(join(s.home, "pics"), { recursive: true });
  writeFileSync(join(s.home, "avatars", "panbungi.png"), PNG);
  writeFileSync(join(s.home, "avatars", "endo.png"), PNG);
  writeFileSync(join(s.home, "pics", "endo.webp"), PNG);
  writeFileSync(join(s.home, "avatars", "yoridori.txt"), "not a picture");
  return s;
}

test("agents.json avatar comes first, then DORI_HOME/avatars/<name>.<image>; anything else is no picture", () => {
  const { home: h } = home();
  const agents = loadAgents(h);
  expect(avatarFile(h, "endo", agents)).toBe(join(h, "pics", "endo.webp"));
  expect(avatarFile(h, "panbungi", agents)).toBe(join(h, "avatars", "panbungi.png"));
  expect(avatarFile(h, "yoridori", agents)).toBeNull();
  expect(avatarFile(h, "../agents", agents)).toBeNull();
  writeFileSync(
    join(h, "agents.json"),
    JSON.stringify([{ name: "x", host: "", profile: "x", role: "r", description: "d", avatar: 3 }]),
  );
  expect(() => loadAgents(h)).toThrow("avatar must be a string");
});

test("the board serves the pictures and shows them in the list, the phone strip, the detail pane and the mission map", async () => {
  const { url, home: h } = home();
  const res = await fetch(`${url}/avatar/panbungi`, { headers: tailnet() });
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  expect((await fetch(`${url}/avatar/%2E%2E%2Fagents.json`, { headers: tailnet() })).status).toBe(404);
  expect((await fetch(`${url}/avatar/yoridori`, { headers: tailnet() })).status).toBe(404);
  writeFileSync(
    join(h, "delegations.jsonl"),
    `${JSON.stringify({ at: "2026-11-13T00:05:00.000Z", agent: "panbungi", text: "[함께] 초안", outcome: "ok", output: "끝" })}\n`,
  );
  const page = await (await fetch(`${url}/?c=bot:panbungi`, { headers: tailnet() })).text();
  const img = /<img class="av" src="(\/avatar\/panbungi\?v=\d+)" alt="" title="판붕이">/.exec(page);
  expect(img).not.toBeNull();
  expect(page).toContain(`<span class="ra"><img class="av" src="${img![1]}"`);
  expect(page).toContain(`<img class="av lg" src="${img![1]}" alt="" title="판붕이">`);
  expect(page).toContain(`<img class="av xl" src="${img![1]}" alt="" title="판붕이">`);
  expect(page).toMatch(/<span class="av lg" style="--h:\d+" title="요리도리">요<\/span>/);
  const map = await (await fetch(`${url}/?m=${encodeURIComponent("tag:함께")}`, { headers: tailnet() })).text();
  expect(map).toContain(
    `<div class="mh" style="grid-column:2;grid-row:1"><a href="/?c=bot%3Apanbungi"><img class="av" src="${img![1]}"`,
  );
});

test("dori agents avatars takes the Discord account picture, else the hermes profile picture, else none", async () => {
  const { home: h } = home();
  const calls: string[][] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    const line = argv.at(-1) ?? "";
    if (line.includes("discord.com") && argv[0] === "ubuntu")
      return { code: 0, stdout: JSON.stringify({ id: "123", avatar: "abc" }), stderr: "" };
    if (line.includes("discord.com")) return { code: 22, stdout: "", stderr: "401" };
    if (line.includes("profiles/endo/assets"))
      return { code: 0, stdout: Buffer.from(PNG).toString("base64"), stderr: "" };
    return { code: 1, stdout: "", stderr: "No such file" };
  };
  const fetched: string[] = [];
  const get = (async (u: string) => {
    fetched.push(u);
    return new Response(PNG);
  }) as unknown as typeof fetch;
  const lines = await syncAvatars(exec, h, loadAgents(h), get);
  expect(lines).toEqual(["AVATAR panbungi discord", "AVATAR endo profile", "NO_AVATAR yoridori"]);
  expect(fetched).toEqual(["https://cdn.discordapp.com/avatars/123/abc.png?size=256"]);
  expect(calls[0]?.slice(0, 2)).toEqual(["ssh", "ubuntu"]);
  expect(calls[2]?.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(new Uint8Array(readFileSync(join(h, "avatars", "endo.png")))).toEqual(PNG);
});
