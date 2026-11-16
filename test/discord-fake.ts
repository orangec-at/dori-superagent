import type { DiscordAnswer, DiscordCall } from "../src/discord-api.ts";

export const GUILD = "900000000000000001";
export const DORI = "900000000000000011";
export const FMV = "900000000000000012";
export const DM = "900000000000000099";
export const ME = "800000000000000001";
export const msg = (id: string, content: string, author = { id: ME, username: "jaeil" }) => ({
  id,
  content,
  timestamp: "2026-11-16T00:00:00.000Z",
  author,
});

/** A Discord that answers from `routes` (path -> answer, or a list taken in order) and records every call. */
export function fakeDiscord(routes: Record<string, DiscordAnswer | DiscordAnswer[]>) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const call: DiscordCall = async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET", ...(init ? { body: init.body } : {}) });
    const key = `${init?.method ?? "GET"} ${path}`;
    const r = routes[key] ?? routes[`${init?.method ?? "GET"} ${path.split("?")[0]}`];
    const answer = Array.isArray(r) ? r.shift() : r;
    return answer ?? { status: 404, body: null, retryAfter: 0 };
  };
  return { call, calls };
}
export const ok = (body: unknown): DiscordAnswer => ({ status: 200, body, retryAfter: 0 });
export const fail = (status: number): DiscordAnswer => ({ status, body: null, retryAfter: 0 });

/**
 * One server whose @everyone may view channels (permissions 1024), two text channels and a voice one, no threads, and
 * one DM.
 */
export const BASE = {
  "GET /users/@me/guilds": ok([{ id: GUILD, name: "workspace-jelly" }]),
  [`GET /guilds/${GUILD}/roles`]: ok([{ id: GUILD, name: "@everyone", permissions: "1024" }]),
  [`GET /guilds/${GUILD}/channels`]: ok([
    { id: FMV, name: "fmv", type: 0, position: 2 },
    { id: DORI, name: "dori", type: 0, position: 1 },
    { id: "900000000000000013", name: "voice", type: 2, position: 3 },
  ]),
  [`GET /guilds/${GUILD}/threads/active`]: ok({ threads: [] }),
  "POST /users/@me/channels": ok({ id: DM, recipients: [{ username: "jaeil", global_name: "Jaeil Lee" }] }),
};
