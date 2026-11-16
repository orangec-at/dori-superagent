import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectLinks, type LinkSnapshot } from "../src/board-links.ts";
import { readLinks, saveLinks } from "../src/board-links-file.ts";
import { parseHermes, parseHermesScan, parseOmo } from "../src/board-links-read.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { saveLeadState } from "../src/standing.ts";
import type { Lane } from "../src/store-types.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

// The lead's GitHub issue channel names the board repo, which DORI_BOARD_REPO overrides: pinned so the shell's value never matters.
const savedRepo = process.env["DORI_BOARD_REPO"];
beforeEach(() => {
  process.env["DORI_BOARD_REPO"] = "acme/test-board";
});
afterEach(() => {
  if (savedRepo === undefined) delete process.env["DORI_BOARD_REPO"];
  else process.env["DORI_BOARD_REPO"] = savedRepo;
});

const snap = (home: string): LinkSnapshot => {
  const s = readLinks(home);
  if (s === null || s === "broken") throw new Error(`board-links.json: ${s}`);
  return s;
};
const page = async (url: string) => (await fetch(`${url}/?tab=map`, { headers: tailnet() })).text();

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
    "GitHub 이슈 (test-board)",
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
  expect(snap(s.home).actors.length).toBe(4);
  const html = await (await fetch(`${s.url}/?tab=map`, { headers: tailnet() })).text();
  expect(html).toContain('aria-label="연결 지도"');
  expect(html).toContain('<a class="lkc" href="/?c=bot%3Apanbungi">');
  expect(html).toContain("🖥 ubuntu");
  expect(html).not.toContain('class="detail"');
});

const lane = (key: string, machine: string): Lane => ({
  key,
  sessionRef: { runtime: "herdr", id: "w1:p5", machine },
  paneId: "w1:p5",
  tabId: "",
  brief: `/b/${key}.md`,
  cwd: "/repo",
  status: "working",
  createdAt: NOW - 7_200_000,
  lastActivityAt: NOW - 60_000,
  nudges: 0,
  log: [],
});

test("a lane machine that is not a plain [user@]host never reaches ssh and reads as unknown", async () => {
  const s = home();
  s.store.saveLane(lane("evil", "-oProxyCommand=touch /tmp/pwned"));
  s.store.saveLane(lane("mini", "mac@mac-macmini"));
  const calls: string[][] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const by = Object.fromEntries(
    (await collectLinks(exec, s.store, { now: NOW, agentCmd: "omo", local: "fedora" })).actors.map((a) => [a.id, a]),
  );
  expect(calls.flat().some((a) => a.includes("ProxyCommand"))).toBe(false);
  expect(calls.some((c) => c[0] === "ssh" && c.includes("mac@mac-macmini"))).toBe(true);
  expect(by["lane:evil"]).toMatchObject({ provider: null, model: null });
});

test("one deadline bounds the whole collection: a machine still silent then is killed and read as unknown", async () => {
  const s = home();
  const killed: string[] = [];
  const exec: Exec = async (cmd, argv, options) => {
    if (cmd === "sh") return { code: 0, stdout: HERMES_OUT, stderr: "" };
    if (!argv.includes("ubuntu")) return { code: 255, stdout: "", stderr: "" };
    return new Promise((resolve) =>
      options?.onSpawn?.({
        kill: () => {
          killed.push("ubuntu");
          resolve({ code: 143, stdout: "", stderr: "" });
        },
      }),
    );
  };
  const got = await collectLinks(exec, s.store, { now: NOW, agentCmd: "hermes", local: "fedora", deadlineMs: 30 });
  expect(killed.length).toBeGreaterThan(0);
  expect(got.unknown).toContain("수집 시간 초과 (1초): 그 뒤 답은 받지 않음");
  expect(got.actors.find((a) => a.id === "bot:panbungi")).toMatchObject({ model: null, source: "ssh로 읽지 못함" });
});

test("an agents.json that cannot be read shows as 알 수 없음 instead of zero bots", async () => {
  const s = home();
  writeFileSync(join(s.home, "agents.json"), "{not json");
  const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
  const got = await collectLinks(exec, s.store, { now: NOW, agentCmd: "omo", local: "fedora" });
  expect(got.unknown[0]).toBe("봇 목록: 알 수 없음 (agents.json을 읽지 못함)");
  saveLinks(s.home, got);
  expect(await page(s.url)).toContain("봇 목록: 알 수 없음 (agents.json을 읽지 못함)");
});

test("a damaged board-links.json is read as broken and the tab says so instead of failing", async () => {
  const s = home();
  const path = join(s.home, "board-links.json");
  expect(readLinks(s.home)).toBeNull();
  writeFileSync(path, "{");
  expect(readLinks(s.home)).toBe("broken");
  writeFileSync(path, JSON.stringify({ generatedAt: 1, actors: [{ id: "lead", kind: "lead" }], unknown: [] }));
  expect(readLinks(s.home)).toBe("broken");
  const res = await fetch(`${s.url}/?tab=map`, { headers: tailnet() });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("연결 정보 파일(board-links.json)이 손상돼서 그릴 수 없어요");
});

test("duty and a standing lead are drawn beside the lead, with the standing lead's hand-off as a dashed line", async () => {
  const s = home();
  s.store.setRole("duty", { runtime: "herdr", id: "w1:p9" });
  writeFileSync(join(s.home, "leads.json"), JSON.stringify([{ domain: "vg", bots: ["panbungi"] }]));
  saveLeadState(s.home, {
    domain: "vg",
    sessionRef: { runtime: "herdr", id: "w1:p8" },
    startedAt: NOW,
    trialEndsAt: NOW + 86_400_000,
  });
  const exec: Exec = async () => ({ code: 0, stdout: HERMES_OUT, stderr: "" });
  saveLinks(s.home, await collectLinks(exec, s.store, { now: NOW, agentCmd: "omo", local: "fedora" }));
  expect(snap(s.home).actors.find((a) => a.id === "bot:panbungi")?.from).toEqual(["lead", "standing:vg"]);
  const html = await page(s.url);
  expect(html).toContain("duty (당번)");
  expect(html).toContain("vg lead");
  expect(html).toContain("상설 lead");
  expect(html).toContain('<path class="e sd"');
});

const SCAN_UBUNTU = `PROFILE default\n  default: gpt-6.1-sol\n  provider: openai-codex\nHAS SLACK_BOT_TOKEN\nPROFILE panbungi\n  default: gpt-6.1-sol\nPROFILE hongbungi\n  default: gpt-6.1-sol\nHAS DISCORD_BOT_TOKEN\nPROFILE ../x\nGATEWAY\n`;

test("hermes profiles agents.json does not list are found on each machine; ubuntu's Slack one is the relay", async () => {
  expect(parseHermesScan(SCAN_UBUNTU)?.profiles.map((p) => p.name)).toEqual(["default", "panbungi", "hongbungi"]);
  expect(parseHermesScan(SCAN_UBUNTU)?.gateway).toBe(true);
  const s = home();
  const exec: Exec = async (cmd, argv) => {
    const script = argv.at(-1) ?? "";
    if (!script.includes("PROFILE")) return { code: 0, stdout: HERMES_OUT, stderr: "" };
    if (cmd === "sh") return { code: 0, stdout: "PROFILE endo\nPROFILE yoridori\n", stderr: "" };
    return argv.includes("ubuntu")
      ? { code: 0, stdout: SCAN_UBUNTU, stderr: "" }
      : { code: 255, stdout: "", stderr: "" };
  };
  saveLinks(s.home, await collectLinks(exec, s.store, { now: NOW, agentCmd: "omo", local: "fedora" }));
  const actors = snap(s.home).actors;
  expect(actors.filter((a) => a.id.startsWith("relay:") || a.id.startsWith("hermes:")).map((a) => a.id)).toEqual([
    "hermes:fedora:yoridori",
    "relay:ubuntu:default",
    "hermes:ubuntu:hongbungi",
  ]);
  expect(actors.find((a) => a.id === "relay:ubuntu:default")).toMatchObject({
    kind: "relay",
    label: "Slack 중계 hermes (ubuntu)",
    computer: "ubuntu",
    model: "gpt-6.1-sol",
    via: "hermes-gateway.service",
    channels: [
      { name: "Slack 스레드", with: "재일 님", dir: "both" },
      { name: "중계", with: "도리도라", dir: "out" },
    ],
  });
  const html = await page(s.url);
  expect(html).toContain("Slack 중계 hermes (ubuntu)");
  expect(html).toContain("중계 봇");
  expect(html).not.toContain("/?c=relay");
});
