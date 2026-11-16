import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectLinks, readLinks, saveLinks } from "../src/board-links.ts";
import { parseHermes, parseOmo } from "../src/board-links-read.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const HERMES_OUT = `  default: "gpt-6.1-sol"\n  provider: "openai-codex"\nHAS DISCORD_BOT_TOKEN\nHAS GH_TOKEN\n`;

test("a config value that is not a plain name is not shown", () => {
  expect(parseHermes(HERMES_OUT)).toEqual({
    found: true,
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    has: new Set(["DISCORD_BOT_TOKEN", "GH_TOKEN"]),
  });
  expect(parseHermes("model: claude-x\n")?.model).toBe("claude-x");
  expect(parseHermes(`  default: "a b c"\n  provider: ${"x".repeat(81)}\n`)).toMatchObject({
    provider: null,
    model: null,
  });
  expect(parseHermes("NO_PROFILE\n")?.found).toBe(false);
  expect(parseHermes(null)).toBeNull();
  expect(parseOmo(`"defaultProvider": "anthropic-subscription"\n"defaultModel": "claude-opus-5-5"`)).toEqual({
    provider: "anthropic-subscription",
    model: "claude-opus-5-5",
  });
});

function home() {
  const s = start();
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify([
      { name: "endo", host: "", profile: "endo", role: "review", description: "엔도(fedora): 검토" },
      { name: "panbungi", host: "ubuntu", profile: "panbungi", role: "sales", description: "판붕이(ubuntu): 영업" },
      {
        name: "appminhee",
        host: "mac@mac-macmini",
        profile: "appminhee",
        role: "ios",
        description: "앱민희(mini): iOS",
      },
    ]),
  );
  mkdirSync(join(s.home, "bin"), { recursive: true });
  for (const f of ["dori-reply", "dori-slack-reply"]) writeFileSync(join(s.home, "bin", f), "#!/bin/sh\n");
  return s;
}

test("collects each machine over sh or read-only ssh; what it cannot read is listed as unknown", async () => {
  const s = home();
  const calls: string[][] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    const script = argv.at(-1) ?? "";
    if (script.includes(".omo"))
      return { code: 0, stdout: `"defaultProvider": "anthropic-subscription"\n`, stderr: "" };
    if (argv.includes("mac@mac-macmini")) return { code: 255, stdout: "", stderr: "timeout" };
    return { code: 0, stdout: HERMES_OUT, stderr: "" };
  };
  const snap = await collectLinks(exec, s.store, { now: NOW, agentCmd: "omo", local: "fedora" });
  const by = Object.fromEntries(snap.actors.map((a) => [a.id, a]));
  expect(by["lead"]).toMatchObject({ computer: "fedora", cli: "omo · herdr", provider: "anthropic-subscription" });
  expect(by["lead"]!.channels.map((c) => c.name)).toEqual([
    "Discord DM",
    "Slack 스레드",
    "보드 대화",
    "GitHub 이슈 (team-board)",
  ]);
  expect(by["bot:panbungi"]).toMatchObject({ computer: "ubuntu", model: "gpt-6.1-sol", via: "dori delegate (ssh)" });
  expect(by["bot:panbungi"]!.channels.map((c) => c.name)).toEqual(["Discord 봇 (DM·서버)", "GitHub (gh)"]);
  expect(by["bot:appminhee"]).toMatchObject({ computer: "mac-macmini", provider: null, model: null });
  expect(snap.unknown).toEqual([
    "도리도라 (lead): 모델 (omo 기본 설정 (~/.omo/agent/settings.json))",
    "앱민희: provider·모델 (ssh로 읽지 못함)",
  ]);
  const ssh = calls.filter((c) => c[0] === "ssh");
  expect(ssh.map((c) => c.slice(1, 6))).toContainEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "ubuntu"]);
  // A secret's value is never printed: .env is only tested with grep -q.
  for (const c of calls) expect(c.at(-1)!.replace(/grep -q "\^\$k=\." "\$d\/\.env"/g, "")).not.toContain(".env");
});

test("the 연결 tab shows the map from the saved snapshot, and says so when nothing was collected", async () => {
  const s = home();
  const none = await (await fetch(`${s.url}/?tab=map`, { headers: tailnet() })).text();
  expect(none).toContain("아직 연결 정보를 모으지 않았어요");
  const exec: Exec = async () => ({ code: 0, stdout: HERMES_OUT, stderr: "" });
  saveLinks(s.home, await collectLinks(exec, s.store, { now: NOW, agentCmd: "omo", local: "fedora" }));
  expect(readLinks(s.home)?.actors.length).toBe(4);
  const html = await (await fetch(`${s.url}/?tab=map`, { headers: tailnet() })).text();
  expect(html).toContain('aria-label="연결 지도"');
  expect(html).toContain('<a class="lkc" href="/?c=bot%3Apanbungi">');
  expect(html).toContain("🖥 ubuntu");
  expect(html).not.toContain('class="detail"');
});
