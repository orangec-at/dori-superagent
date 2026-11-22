import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { officeTab } from "../src/board-office-html.ts";
import { officeRemotes, parseRemote, remoteLeads, remoteScript } from "../src/board-office-remote.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const BOKDORA = { machine: "bokdora", ssh: "bokdora", lead: "보리", role: "조율(lead)", home: "/home/bok-q/.dori" };
const PANE = JSON.stringify({
  id: "cli:pane:get",
  result: { pane: { agent: "claude", agent_status: "working", pane_id: "w1:p1", title: "보경 님 요청 정리" } },
});
const lane = (key: string, at: number): string => JSON.stringify({ key, log: [{ at, kind: "start", text: "b.md" }] });
const OUT = `@@LEAD w1:p1\n${PANE}\n\n@@LANE\n${lane("new", NOW - 5 * 60_000)}\n\n@@LANE\n${lane("old", NOW - 60 * 60_000)}\n`;

test("board.json office.remotes gives each computer and its lead; unsafe or incomplete entries are skipped", () => {
  const s = start();
  expect(officeRemotes(s.home)).toEqual([]);
  writeFileSync(
    join(s.home, "board.json"),
    JSON.stringify({
      office: {
        remotes: [
          { machine: "bokdora", ssh: "bokdora", lead: "보리", home: "/home/bok-q/.dori" },
          { machine: "mini", ssh: "mac@mac-mini", lead: "앱리드", role: "iOS", home: "~/x" },
          { machine: "evil", ssh: "-oProxyCommand=sh", lead: "x" },
          { machine: "nolead", ssh: "host" },
          "bokdora",
        ],
      },
    }),
  );
  expect(officeRemotes(s.home)).toEqual([
    BOKDORA,
    { machine: "mini", ssh: "mac@mac-mini", lead: "앱리드", role: "iOS", home: null },
  ]);
});

test("the remote script reads the given dori home, else ~/.dori, and marks the pane and each lane", () => {
  expect(remoteScript("/home/bok-q/.dori")).toContain('H="/home/bok-q/.dori"');
  expect(remoteScript(null)).toContain('H="$HOME/.dori"');
  expect(remoteScript(null)).toContain('echo "@@LEAD $L"; [ -n "$L" ] && herdr pane get "$L"');
  expect(parseRemote(OUT)).toEqual({
    pane: { status: "working", title: "보경 님 요청 정리" },
    seen: { at: NOW - 5 * 60_000, what: "lane new 시작" },
  });
  const idle = OUT.replace('"working"', '"idle"');
  expect(parseRemote(idle)?.pane?.status).toBe("idle");
  expect(parseRemote(`${idle}\n@@BUSY\n`)?.pane?.status).toBe("working");
  expect(parseRemote("@@LEAD \n")).toEqual({ pane: null, seen: null });
  expect(parseRemote("Permission denied")).toBeNull();
});

test("a remote lead's seat comes from the last ssh read; no read yet, a failed ssh or a timeout is 연결 안 됨", async () => {
  const calls: string[][] = [];
  let answer: Awaited<ReturnType<Exec>> | Error = { code: 0, stdout: OUT, stderr: "" };
  const exec: Exec = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const logs: string[] = [];
  const r = remoteLeads(exec, [BOKDORA], (l) => logs.push(l));
  expect(r.seats()[0]).toMatchObject({ status: "unknown", word: "연결 안 됨", label: "보리", machine: "bokdora" });
  await r.tick();
  expect(calls[0]?.slice(0, 10)).toEqual([
    "timeout",
    "-k",
    "2",
    "15",
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "--",
  ]);
  expect(calls[0]?.[10]).toBe("bokdora");
  expect(r.seats()[0]).toMatchObject({
    name: "bokdora",
    row: "remote:bokdora",
    label: "보리",
    role: "조율(lead)",
    linkless: true,
    status: "working",
    task: "보경 님 요청 정리",
    word: "일하는 중 · 09:55",
  });
  answer = { code: 255, stdout: "", stderr: "ssh: connect to host bokdora port 22: No route to host" };
  await r.tick();
  expect(r.seats()[0]).toMatchObject({ status: "unknown", word: "연결 안 됨", task: null, at: null });
  answer = new Error("spawn failed");
  await r.tick();
  expect(r.seats()[0]?.word).toBe("연결 안 됨");
  await r.tick();
  expect(logs).toEqual([
    "BOARD_REMOTE_LEAD bokdora failed (exit 255: ssh: connect to host bokdora port 22: No route to host)",
    "BOARD_REMOTE_LEAD bokdora failed (exit -1: spawn failed)",
  ]);
});

test("a remote lead gets its own room with a seat that links nowhere, and the served tab draws it", async () => {
  const off = remoteLeads(async () => ({ code: 124, stdout: "", stderr: "" }), [BOKDORA]);
  await off.tick();
  const html = officeTab({ generatedAt: NOW, bots: off.seats() }, {});
  expect(html).toContain('<section class="room" data-machine="bokdora">');
  expect(html).toContain("<span>lead · 봇 0</span>");
  expect(html).toContain('<span class="seat o-unknown" data-row="remote:bokdora"');
  expect(html).not.toContain("?c=remote");
  expect(html).toContain('<span class="cap">연결 안 됨</span>');
  const s = start({ office: { remotes: off.seats } });
  const page = await (await fetch(`${s.url}/?tab=office`, { headers: tailnet() })).text();
  expect(page).toContain('data-machine="bokdora"');
  expect(page).toContain('href="/?c=lead"');
});
