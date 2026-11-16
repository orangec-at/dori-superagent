import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Discord REST calls the board makes with the bot token. The token never leaves this module: callers get a
 * function that takes a path, and every answer comes back as a status, a parsed body and the seconds to wait after a
 * 429 (0 otherwise).
 */
export type DiscordAnswer = { status: number; body: unknown; retryAfter: number };
export type DiscordCall = (path: string, init?: { method: "POST"; body: unknown }) => Promise<DiscordAnswer>;

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 10_000;

/** DORI_HOME/discord/bot.env: the bot token and the user ids allowed to talk to it (their DMs are the board's DMs). */
export function loadDiscordEnv(home: string): { token: string; users: string[] } | null {
  const path = join(home, "discord", "bot.env");
  if (!existsSync(path)) return null;
  const env = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0)
      env.set(
        line.slice(0, i).trim(),
        line
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
  }
  const token = env.get("DISCORD_BOT_TOKEN") ?? "";
  const users = (env.get("DISCORD_ALLOWED_USERS") ?? "").split(",").filter((u) => /^\d+$/.test(u.trim()));
  return token ? { token, users: users.map((u) => u.trim()) } : null;
}

export function discordCall(token: string): DiscordCall {
  return async (path, init) => {
    const res = await fetch(`${API}${path}`, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "dori-board" },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    const after = res.status === 429 ? Number((body as { retry_after?: unknown } | null)?.retry_after ?? 5) : 0;
    return { status: res.status, body, retryAfter: Number.isFinite(after) ? after : 5 };
  };
}
