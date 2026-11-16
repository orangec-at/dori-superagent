import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { discordCall, loadDiscordEnv } from "../src/discord-api.ts";

const servers: Server<undefined>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const envHome = (text: string): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-discord-env-"));
  mkdirSync(join(home, "discord"));
  writeFileSync(join(home, "discord", "bot.env"), text);
  return home;
};

test("bot.env is read with export prefixes, quotes and comment lines; no token means no Discord", () => {
  const home = envHome(
    '# the bridge bot\nexport DISCORD_BOT_TOKEN="abc.def"\nDISCORD_ALLOWED_USERS=111, 222,x\n# DISCORD_BOT_TOKEN=old\n',
  );
  expect(loadDiscordEnv(home)).toEqual({ token: "abc.def", users: ["111", "222"] });
  expect(loadDiscordEnv(envHome("# DISCORD_BOT_TOKEN=commented\n"))).toBeNull();
  expect(loadDiscordEnv(mkdtempSync(join(tmpdir(), "dori-discord-none-")))).toBeNull();
});

test("a call sends the bot token, parses the body and reads retry_after from a 429", async () => {
  const seen: { auth: string | null; path: string; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ auth: req.headers.get("authorization"), path: url.pathname + url.search, body: await req.text() });
      return url.pathname === "/slow"
        ? Response.json({ message: "rate limited", retry_after: 2.5 }, { status: 429 })
        : Response.json({ id: "1" });
    },
  });
  servers.push(server);
  const call = discordCall("tok", `http://127.0.0.1:${server.port}`);
  expect(await call("/ok?limit=1")).toEqual({ status: 200, body: { id: "1" }, retryAfter: 0 });
  expect(await call("/slow", { method: "POST", body: { content: "x" } })).toEqual({
    status: 429,
    body: { message: "rate limited", retry_after: 2.5 },
    retryAfter: 2.5,
  });
  expect(seen).toEqual([
    { auth: "Bot tok", path: "/ok?limit=1", body: "" },
    { auth: "Bot tok", path: "/slow", body: '{"content":"x"}' },
  ]);
});
