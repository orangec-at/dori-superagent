import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/muse/muse-gw and dori-muse-reply run against a throwaway HOME; `dori` and `dori-notify` are stubs there.
const GW = join(import.meta.dir, "..", "scripts", "muse", "muse-gw");
const REPLY = join(import.meta.dir, "..", "scripts", "muse", "dori-muse-reply");
const WAITING = "(waiting up to";

let home = "";
const env = () => ({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

function stub(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "muse-gw-"));
  mkdirSync(join(home, ".dori", "muse"), { recursive: true });
  mkdirSync(join(home, ".dori", "bin"), { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  stub(join(home, ".dori", "bin", "dori-notify"), "exit 0");
  stub(join(home, ".local", "bin", "dori"), 'echo "SENT m1"');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const gw = (...args: string[]) =>
  Bun.spawn(["python3", GW, ...args], { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
const reply = (text: string) => run(["python3", REPLY, text]);

/** Resolves once the waiter has checked the inbox, found nothing new and started waiting (it says so on stderr). */
async function untilWaiting(p: ReturnType<typeof gw>) {
  const reader = p.stderr.getReader();
  const dec = new TextDecoder();
  let seen = "";
  while (!seen.includes(WAITING)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`waiter exited before waiting; stderr: ${seen}`);
    seen += dec.decode(value);
  }
  reader.releaseLock();
}

const lastAudit = () => {
  const lines = readFileSync(join(home, ".dori", "muse", "audit.jsonl"), "utf8")
    .trim()
    .split("\n");
  return JSON.parse(lines.at(-1)!) as { cmd: string[]; outcome: string };
};

describe("muse-gw inbox --wait", () => {
  test("returns as soon as dori-muse-reply adds a reply during the wait, and audits the wait", async () => {
    const waiter = gw("inbox", "--wait", "30");
    await untilWaiting(waiter);
    const started = performance.now();
    expect((await reply("lead says hi")).code).toBe(0);
    const [out, code] = await Promise.all([new Response(waiter.stdout).text(), waiter.exited]);
    expect(code).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(out).toContain("lead says hi");
    expect(lastAudit()).toMatchObject({ cmd: ["inbox"], outcome: expect.stringMatching(/^read 1 waited \d+s$/) });
    expect((await run(["python3", GW, "inbox"])).out).toContain("(no new replies)");
  }, 20000);

  test("prints (no new replies) when the wait runs out", async () => {
    const r = await run(["python3", GW, "inbox", "--wait", "1"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("(no new replies)");
    expect(lastAudit().outcome).toMatch(/^read 0 waited [12]s$/);
  }, 10000);

  test("returns at once without waiting when a reply is already unread", async () => {
    await reply("already here");
    const r = await run(["python3", GW, "inbox", "--wait", "30"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already here");
    expect(r.err).not.toContain(WAITING);
    expect(lastAudit().outcome).toBe("read 1 waited 0s");
  }, 10000);

  test("send is not blocked while another inbox --wait is waiting", async () => {
    const waiter = gw("inbox", "--wait", "30");
    await untilWaiting(waiter);
    const sent = await run(["python3", GW, "send", "please look at PR 7"]);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("SENT");
    expect(waiter.exitCode).toBeNull();
    await reply("on it");
    const [out, code] = await Promise.all([new Response(waiter.stdout).text(), waiter.exited]);
    expect(code).toBe(0);
    expect(out).toContain("on it");
  }, 20000);

  test("refuses --wait with --all and out-of-range or missing seconds, without waiting", async () => {
    for (const args of [
      ["--wait", "5", "--all"],
      ["--all", "--wait", "5"],
      ["--wait", "0"],
      ["--wait", "56"],
      ["--wait", "x"],
      ["--wait"],
    ]) {
      const r = await run(["python3", GW, "inbox", ...args]);
      expect(r.code).toBe(2);
      expect(r.out).toStartWith("REFUSED:");
      expect(r.err).not.toContain(WAITING);
      expect(lastAudit().outcome).toStartWith("refused:");
    }
  }, 20000);
});
