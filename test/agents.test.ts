import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegate, delegateCommand, loadAgents } from "../src/agents.ts";
import { main } from "../src/cli.ts";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { setup } from "./harness-setup.ts";

const AGENTS = [
  { name: "endo", host: "", profile: "endo", role: "review", description: "code review" },
  { name: "hongbungi", host: "ubuntu", profile: "hongbungi", role: "marketing", description: "" },
];
const NOW = Date.parse("2026-11-10T08:00:00Z");

function home(agents: unknown = AGENTS): string {
  const dir = mkdtempSync(join(tmpdir(), "dori-agents-"));
  writeFileSync(join(dir, "agents.json"), JSON.stringify(agents));
  return dir;
}

function runner(result: ExecResult) {
  const calls: { cmd: string; argv: readonly string[] }[] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push({ cmd, argv });
    return result;
  };
  return { calls, exec };
}

const log = (dir: string) =>
  readFileSync(join(dir, "delegations.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("agents.json is read and checked; a missing file means no agents", () => {
  expect(loadAgents(mkdtempSync(join(tmpdir(), "dori-none-")))).toEqual([]);
  expect(loadAgents(home())).toEqual(AGENTS);
  expect(() => loadAgents(home({}))).toThrow("must be an array");
  expect(() => loadAgents(home([{ name: "x", profile: "p", host: "-oProxyCommand=sh" }]))).toThrow("host must be");
  expect(() => loadAgents(home([{ name: "a b", profile: "p" }]))).toThrow("name must match");
});

test("a local agent runs hermes with the text as one argument; a remote one is one quoted ssh command", async () => {
  const text = "it's $HOME `id`; rm -rf /";
  const hermes = ["-p", "hongbungi", "chat", "-Q", "-q"];
  expect(delegateCommand(AGENTS[0]!, text)).toEqual({ cmd: "hermes", argv: ["-p", "endo", "chat", "-Q", "-q", text] });
  const remote = delegateCommand(AGENTS[1]!, text);
  expect(remote.cmd).toBe("ssh");
  expect(remote.argv[0]).toBe("ubuntu");
  // The remote shell must split the command back into exactly the local argv, quotes, $ and ; untouched.
  const proc = Bun.spawn(["sh", "-c", `printf '%s\\n' ${remote.argv[1]?.replace(/^'hermes' /, "")}`], {
    stdout: "pipe",
  });
  expect((await new Response(proc.stdout).text()).trimEnd().split("\n")).toEqual([...hermes, text]);
});

test("a delegation that succeeds returns the answer and logs time, agent, text, exit code and output", async () => {
  const dir = home();
  const { calls, exec } = runner({ code: 0, stdout: "found 3 sources", stderr: "" });
  const r = await delegate(exec, "endo", `review ${"x".repeat(300)}`, { home: dir, timeoutMs: 60_000, now: () => NOW });
  expect(r).toEqual({ outcome: "ok", code: 0, output: "found 3 sources" });
  expect(calls[0]?.cmd).toBe("hermes");
  expect(log(dir)).toEqual([
    {
      at: "2026-11-10T08:00:00.000Z",
      agent: "endo",
      text: `review ${"x".repeat(193)}`,
      outcome: "ok",
      code: 0,
      output: "found 3 sources",
    },
  ]);
});

test("a delegation that fails keeps the exit code and the agent's reason; output is cut at 2000 characters", async () => {
  const dir = home();
  const failing = runner({ code: 255, stdout: "", stderr: `ssh: connect refused ${"y".repeat(3000)}` });
  const r = await delegate(failing.exec, "hongbungi", "draft", { home: dir, timeoutMs: 60_000, now: () => NOW });
  expect(r.outcome).toBe("failed");
  expect(r.code).toBe(255);
  const [line] = log(dir);
  expect(line?.["code"]).toBe(255);
  expect(String(line?.["output"]).length).toBe(2000);
  const missing: Exec = async () => {
    throw new Error("ENOENT");
  };
  const r2 = await delegate(missing, "endo", "x", { home: dir, timeoutMs: 60_000, now: () => NOW });
  expect(r2).toEqual({ outcome: "failed", code: -1, output: "could not run hermes: Error: ENOENT" });
});

test("a delegation that outlives its timeout is killed and logged as a timeout with no exit code", async () => {
  const dir = home();
  let killed = false;
  const hangs: Exec = (_cmd, _argv, options) =>
    new Promise((resolve) => {
      options?.onSpawn?.({
        kill() {
          killed = true;
          resolve({ code: 143, stdout: "", stderr: "" });
        },
      });
    });
  const r = await delegate(hangs, "endo", "x", { home: dir, timeoutMs: 5, now: () => NOW });
  expect(r).toEqual({ outcome: "timeout", code: null, output: "no answer within 0.005s" });
  expect(killed).toBe(true);
  expect(log(dir)[0]).toMatchObject({ outcome: "timeout", code: null });
});

test("dori agents lists them; dori delegate exits 0, 1 or 124 and refuses an unknown agent", async () => {
  const { d } = setup();
  const out: string[] = [];
  const [l, e, w] = [console.log, console.error, process.stdout.write];
  console.log = console.error = (...a: unknown[]) => void out.push(a.join(" "));
  process.stdout.write = ((s: string) => out.push(s) > 0) as typeof process.stdout.write;
  try {
    expect(await main(["agents"], d)).toBe(0);
    writeFileSync(join(d.store.root, "agents.json"), JSON.stringify(AGENTS));
    expect(await main(["agents"], d)).toBe(0);
    const ok = runner({ code: 0, stdout: "LGTM\n", stderr: "" });
    expect(await main(["delegate", "endo", "--text", "review #9"], { ...d, exec: ok.exec })).toBe(0);
    const bad = runner({ code: 2, stdout: "", stderr: "no profile" });
    expect(await main(["delegate", "endo", "--text", "x"], { ...d, exec: bad.exec })).toBe(1);
    const hangs: Exec = () => new Promise(() => {});
    expect(await main(["delegate", "endo", "--text", "x", "--timeout", "0.001"], { ...d, exec: hangs })).toBe(124);
    await expect(main(["delegate", "nobody", "--text", "x"], d)).rejects.toThrow("no agent nobody");
  } finally {
    [console.log, console.error, process.stdout.write] = [l, e, w];
  }
  expect(out).toEqual([
    `NO_AGENTS ${d.store.root}/agents.json`,
    "endo local endo review - code review",
    "hongbungi ubuntu hongbungi marketing",
    "LGTM\n",
    "DELEGATE_FAILED endo: no profile",
    "DELEGATE_TIMEOUT endo: no answer within 0.001s",
  ]);
  expect(log(d.store.root).map((x) => x["outcome"])).toEqual(["ok", "failed", "timeout"]);
});
