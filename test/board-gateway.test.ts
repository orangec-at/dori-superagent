import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../src/agents.ts";
import { GATEWAY_SCRIPT, type GatewaySeen, gatewayReader, parseGateway } from "../src/board-gateway.ts";
import { type BotRecords, JUST_DONE_MS, liveState, seatLive } from "../src/board-live.ts";
import { officeTab } from "../src/board-office-html.ts";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { spawnExec } from "../src/runtime/exec.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const MIN = 60_000;
const iso = (t: number): string => new Date(t).toISOString();
const jsonl = (rows: object[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
const seen = (o: Partial<GatewaySeen>): GatewaySeen => ({
  at: null,
  platform: null,
  active: null,
  activePlatform: null,
  ...o,
});
const ended = (endAt: number, outcome: string): BotRecords => ({
  runs: [
    { at: endAt - 3 * MIN, until: endAt + 30 * MIN, text: "@dido 명상 기록 시안 v4", end: { at: endAt, outcome } },
  ],
  handed: null,
});

test("a failed delegation stays 실패 with its title until something newer; a newer messenger turn clears it", () => {
  const failed = ended(NOW - 20 * MIN, "failed");
  expect(seatLive(failed, seen({ at: NOW - 30 * MIN, platform: "slack" }), NOW)).toEqual({
    status: "failed",
    task: "명상 기록 시안 v4",
    at: NOW - 20 * MIN,
    running: 0,
    basis: "위임 실패 09:40",
  });
  expect(seatLive(failed, seen({ at: NOW - 5 * MIN, platform: "slack" }), NOW)).toEqual({
    status: "done",
    task: "Slack 대화",
    at: NOW - 5 * MIN,
    running: 0,
    basis: "Slack에서 답함 09:55",
  });
  const later = NOW - 5 * MIN + JUST_DONE_MS;
  expect(seatLive(failed, seen({ at: NOW - 5 * MIN, platform: "discord" }), later)).toMatchObject({
    status: "idle",
    task: null,
    basis: "마지막 Discord 09:55",
  });
});

test("a newer successful delegation clears a 실패 too, and says it was a delegation", () => {
  const r: BotRecords = {
    runs: [...ended(NOW - 40 * MIN, "failed").runs, ...ended(NOW - 5 * MIN, "ok").runs],
    handed: null,
  };
  expect(seatLive(r, seen({}), NOW)).toMatchObject({ status: "done", basis: "위임 끝남 09:55" });
});

test("a messenger turn running now is 일하는 중 there; a delegation at work still comes first; a stale mark is not", () => {
  const gw = seen({ at: NOW - 2 * MIN, platform: "slack", active: NOW - 2 * MIN, activePlatform: "slack" });
  expect(seatLive(ended(NOW - 20 * MIN, "failed"), gw, NOW)).toEqual({
    status: "working",
    task: "Slack 대화",
    at: NOW - 2 * MIN,
    running: 1,
    basis: "Slack에서 일하는 중",
  });
  const open: BotRecords = { runs: [{ at: NOW - MIN, until: NOW + 30 * MIN, text: "@dido 시안 v5" }], handed: null };
  expect(seatLive(open, gw, NOW)).toMatchObject({ status: "working", task: "시안 v5", basis: "위임 일하는 중" });
  const stale = seen({ at: NOW - 5 * 60 * MIN, active: NOW - 5 * 60 * MIN, activePlatform: "slack" });
  expect(seatLive(ended(NOW - 20 * MIN, "failed"), stale, NOW).status).toBe("failed");
});

test("a machine that could not be read keeps the delegation state and says the messengers are unknown", () => {
  expect(seatLive(ended(NOW - 20 * MIN, "failed"), null, NOW).basis).toBe("위임 실패 09:40 · 메신저 확인 안 됨");
  expect(seatLive({ runs: [], handed: null }, undefined, NOW).basis).toBe("기록 없음");
});

function seeded(o: Parameters<typeof start>[0] = {}) {
  const s = start(o);
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify([
      { name: "dido", host: "", profile: "dido", role: "design", description: "디도(fedora): 디자인" },
      { name: "endo", host: "", profile: "endo", role: "review", description: "엔도(fedora): 검토" },
    ]),
  );
  const at = NOW - 30 * MIN;
  const rows = [
    { at: iso(at), agent: "dido", text: "@dido 명상 기록 시안 v4" },
    { at: iso(at), agent: "endo", text: "@endo PR 검토" },
  ];
  writeFileSync(join(s.home, "delegate-runs.jsonl"), jsonl(rows.map((r) => ({ ...r, until: iso(NOW) }))));
  const lost = "Error: Gateway disconnected; turn outcome is unknown. Resume the print";
  writeFileSync(
    join(s.home, "delegations.jsonl"),
    jsonl([
      { ...rows[0], outcome: "failed", code: 1, output: lost, endedAt: iso(NOW - 25 * MIN) },
      { ...rows[1], outcome: "failed", code: 1, output: "build broke", endedAt: iso(NOW - 25 * MIN) },
    ]),
  );
  return s;
}

test("a delegation the gateway lost is 결과 모름, not 실패; a plain failure stays 실패", () => {
  const { store } = seeded();
  const bots = liveState(store, NOW).bots;
  expect(bots.map((b) => [b.name, b.status, b.word, b.task, b.basis])).toEqual([
    ["dido", "unsure", "결과 모름", "명상 기록 시안 v4", "위임 결과 모름 09:35"],
    ["endo", "failed", "실패", "PR 검토", "위임 실패 09:35"],
  ]);
  const html = officeTab({ generatedAt: NOW, bots }, {});
  expect(html).toContain('class="seat o-unsure"');
  expect(html).toContain("<i>명상 기록 시안 v4</i>");
  expect(html).toContain("위임 결과 모름 09:35");
});

test("the served 지금 and 사무실 tabs and GET /api/live use the gateway reader's last answer", async () => {
  const gateway = (a: Agent): GatewaySeen | null =>
    a.name === "dido" ? seen({ at: NOW - 3 * MIN, platform: "slack" }) : null;
  const served = seeded({ office: { gateway } });
  const live = await (await fetch(`${served.url}/?tab=live`, { headers: tailnet() })).text();
  expect(live).toContain('data-bot="dido" data-status="done"');
  expect(live).toContain("Slack에서 답함 09:57");
  expect(live).toContain("위임 실패 09:35 · 메신저 확인 안 됨");
  const office = await (await fetch(`${served.url}/?tab=office`, { headers: tailnet() })).text();
  expect(office).toContain("Slack에서 답함 09:57");
  const api = (await (await fetch(`${served.url}/api/live`, { headers: tailnet() })).json()) as {
    bots: { name: string; status: string }[];
  };
  expect(api.bots.map((b) => [b.name, b.status])).toEqual([
    ["dido", "done"],
    ["endo", "failed"],
  ]);
});

test("parseGateway keeps only well-formed profiles, numbers and platform names", () => {
  expect(parseGateway("not json")).toBeNull();
  expect(parseGateway("[1]")).toBeNull();
  expect(
    parseGateway(
      JSON.stringify({
        dido: { at: 5, platform: "slack", active: null, activePlatform: null },
        "bad name<": { at: 1 },
        endo: { at: "x", platform: "<b>", active: 7, activePlatform: "discord" },
      }),
    ),
  ).toEqual({
    dido: seen({ at: 5, platform: "slack" }),
    endo: seen({ active: 7, activePlatform: "discord" }),
  });
});

const agent = (name: string, host: string): Agent => ({ name, host, profile: name, role: "r", description: "" });

test("the reader runs the script here and over ssh per machine, with a time limit; a failed machine is null", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const answers: Record<string, ExecResult> = {
    local: { code: 0, stdout: JSON.stringify({ dido: { at: 9, platform: "slack" } }), stderr: "" },
    ubuntu: { code: 255, stdout: "", stderr: "ssh: connect to host ubuntu port 22: No route to host\n" },
  };
  const exec: Exec = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    return argv.includes("ssh") ? (answers["ubuntu"] as ExecResult) : (answers["local"] as ExecResult);
  };
  const bots = [agent("dido", ""), agent("endo", ""), agent("hong", "ubuntu")];
  const r = gatewayReader(
    exec,
    () => bots,
    (l) => logs.push(l),
  );
  expect(r.seen(agent("dido", ""))).toBeNull();
  await r.tick();
  await r.tick();
  expect(calls).toHaveLength(4);
  expect(calls[0]?.slice(0, 6)).toEqual(["timeout", "-k", "2", "15", "python3", "-c"]);
  expect(calls[1]?.slice(4, 11)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "ubuntu"]);
  expect(calls[1]?.[11]).toMatch(/^python3 -c "import base64; exec\(base64\.b64decode\('[A-Za-z0-9+/=]+'\)\)"$/);
  expect(r.seen(agent("dido", ""))).toEqual(seen({ at: 9, platform: "slack" }));
  expect(r.seen(agent("endo", ""))).toEqual(seen({}));
  expect(r.seen(agent("hong", "ubuntu"))).toBeNull();
  expect(logs).toEqual([
    "BOARD_GATEWAY ubuntu failed (exit 255: ssh: connect to host ubuntu port 22: No route to host)",
  ]);
});

test("the script reads every profile's messenger sessions, newest first, and leaves dori delegate's local ones out", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-gw-"));
  try {
    mkdirSync(join(home, ".hermes", "sessions"), { recursive: true });
    mkdirSync(join(home, ".hermes", "profiles", "bido", "sessions"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "sessions", "sessions.json"),
      JSON.stringify({
        _README: "mirror",
        "agent:dido:slack:group:C1": { platform: "slack", updated_at: "2026-11-22T16:32:55.031158" },
        "agent:dido:discord:dm:1": { platform: "discord", updated_at: "2026-11-22T16:00:00" },
        "agent:dido:local:dm:local-1": {
          platform: "local",
          updated_at: "2026-11-22T17:00:00",
          active_turn_started_at: "2026-11-22T08:00:00+00:00",
        },
        "agent:endo:discord:dm:2": { platform: "discord", active_turn_started_at: "2026-11-22T07:41:51+00:00" },
      }),
    );
    writeFileSync(
      join(home, ".hermes", "profiles", "bido", "sessions", "sessions.json"),
      JSON.stringify({ "agent:bido:discord:dm:3": { platform: "discord", updated_at: "2026-11-22T13:47:33" } }),
    );
    const out = await spawnExec("python3", ["-c", GATEWAY_SCRIPT], {
      env: { HOME: home, TZ: "UTC", PATH: process.env["PATH"] ?? "" },
    });
    expect(out.code).toBe(0);
    expect(parseGateway(out.stdout)).toEqual({
      dido: seen({ at: Date.UTC(2026, 10, 22, 16, 32, 55, 31), platform: "slack" }),
      endo: seen({ active: Date.UTC(2026, 10, 22, 7, 41, 51), activePlatform: "discord" }),
      bido: seen({ at: Date.UTC(2026, 10, 22, 13, 47, 33), platform: "discord" }),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
