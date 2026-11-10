import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { parseAddress, ReplyError, reply } from "../src/reply.ts";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { setup } from "./harness-setup.ts";

const HOME = "/dori-home";

function runner(result: ExecResult = { code: 0, stdout: "OK 1.2", stderr: "" }) {
  const calls: { cmd: string; argv: readonly string[] }[] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push({ cmd, argv });
    return result;
  };
  return { calls, exec };
}

test("each address kind is parsed; anything else is refused with the accepted forms", () => {
  expect(parseAddress("slack:C0123:1731200000.000100")).toEqual({
    kind: "slack",
    channel: "C0123",
    thread: "1731200000.000100",
  });
  expect(parseAddress("discord:123456789012")).toEqual({ kind: "discord", channel: "123456789012" });
  expect(parseAddress("hermes:ubuntu/doridora")).toEqual({ kind: "hermes", machine: "ubuntu", profile: "doridora" });
  for (const bad of ["slack:C1", "discord:general", "hermes:ubuntu", "hermes:a/b/c", "email:x", "slack:C1:1;rm"])
    expect(() => parseAddress(bad)).toThrow("is not a reply address");
});

test("slack goes through DORI_HOME/bin/dori-slack-reply with the thread and every file", async () => {
  const { calls, exec } = runner();
  await reply(exec, "slack:C0123:17.1", "done: PR #9", { home: HOME, files: ["a.png", "b.log"] });
  expect(calls).toEqual([
    {
      cmd: "/dori-home/bin/dori-slack-reply",
      argv: ["C0123", "17.1", "--file", "a.png", "--file", "b.log", "done: PR #9"],
    },
  ]);
});

test("discord goes through DORI_HOME/bin/dori-reply; a file for discord is refused before anything runs", async () => {
  const { calls, exec } = runner();
  await reply(exec, "discord:42", "hello", { home: HOME });
  expect(calls).toEqual([{ cmd: "/dori-home/bin/dori-reply", argv: ["42", "hello"] }]);
  await expect(reply(exec, "discord:42", "x", { home: HOME, files: ["a.png"] })).rejects.toThrow("--file is only");
  expect(calls).toHaveLength(1);
});

test("hermes on this machine runs hermes here; on another machine one quoted ssh command", async () => {
  const { calls, exec } = runner();
  await reply(exec, "hermes:fedora/doridora", "it's done", { home: HOME, self: "fedora" });
  await reply(exec, "hermes:ubuntu/doridora", "it's $HOME `id`", { home: HOME, self: "fedora" });
  const hermes = ["-p", "doridora", "chat", "-c", "Bot Chat", "-Q", "-q"];
  expect(calls[0]).toEqual({ cmd: "hermes", argv: [...hermes, "it's done"] });
  expect(calls[1]?.cmd).toBe("ssh");
  expect(calls[1]?.argv[0]).toBe("ubuntu");
  // The remote shell must split the command back into exactly the local argv, quotes and $ untouched.
  const proc = Bun.spawn(["sh", "-c", `printf '%s\\n' ${calls[1]?.argv[1]?.replace(/^'hermes' /, "")}`], {
    stdout: "pipe",
  });
  expect((await new Response(proc.stdout).text()).trimEnd().split("\n")).toEqual([...hermes, "it's $HOME `id`"]);
});

test("a sender that exits non-zero or cannot start fails with its own reason", async () => {
  const failing = runner({ code: 1, stdout: "ERR channel_not_found\n", stderr: "" });
  const err = await reply(failing.exec, "slack:C9:1.2", "x", { home: HOME }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplyError);
  expect((err as Error).message).toBe(
    "REPLY_FAILED slack:C9:1.2: /dori-home/bin/dori-slack-reply exited 1: ERR channel_not_found",
  );
  const missing: Exec = async () => {
    throw new Error("ENOENT: hermes");
  };
  await expect(reply(missing, "hermes:local/p", "x", { home: HOME })).rejects.toThrow(
    "REPLY_FAILED hermes:local/p: could not run hermes: ENOENT: hermes",
  );
});

test("dori reply prints REPLIED and exits 0, or prints the reason and exits 1", async () => {
  const { d } = setup();
  const out: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = console.error = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  try {
    const ok = runner();
    expect(await main(["reply", "discord:7", "all", "done"], { ...d, exec: ok.exec })).toBe(0);
    expect(ok.calls[0]?.argv).toEqual(["7", "all done"]);
    const bad = runner({ code: 2, stdout: "", stderr: "token missing" });
    expect(await main(["reply", "discord:7", "--text", "x"], { ...d, exec: bad.exec })).toBe(1);
  } finally {
    [console.log, console.error] = [log, error];
  }
  expect(out).toEqual([
    "REPLIED discord:7",
    `REPLY_FAILED discord:7: ${d.store.root}/bin/dori-reply exited 2: token missing`,
  ]);
});
