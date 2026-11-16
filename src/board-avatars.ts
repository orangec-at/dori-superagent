import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { type Agent, loadAgents } from "./agents.ts";
import type { Exec } from "./runtime/exec.ts";

/**
 * Bot pictures on the board. The board shows agents.json `avatar` (a path: absolute, `~/…` or relative to DORI_HOME),
 * else DORI_HOME/avatars/<name>.<png|jpg|jpeg|webp>; `lead` is the lead's own picture. Without one a row keeps its
 * letter circle. `dori agents avatars` fills DORI_HOME/avatars: the bot's Discord account picture, else its hermes
 * profile's assets/avatar.png.
 */

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const dir = (home: string): string => join(home, "avatars");
const resolved = (home: string, p: string): string =>
  p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : join(home, p);

/** The picture file of a bot (or `lead`), or null: only an existing image file under 2 MB counts. */
export function avatarFile(home: string, name: string, agents: Agent[]): string | null {
  if (!NAME.test(name)) return null;
  const given = agents.find((a) => a.name === name)?.avatar;
  const candidates = [
    ...(given ? [resolved(home, given)] : []),
    ...Object.keys(TYPES).map((ext) => join(dir(home), `${name}${ext}`)),
  ];
  return (
    candidates.find((p) => {
      if (!TYPES[extname(p).toLowerCase()] || !existsSync(p)) return false;
      const st = statSync(p);
      return st.isFile() && st.size > 0 && st.size <= MAX_BYTES;
    }) ?? null
  );
}

/** Row id (`bot:<name>`, `lead`) -> the board URL of its picture, versioned by the file's mtime so a new one shows. */
export function avatarUrls(home: string, agents: Agent[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of [["lead", "lead"], ...agents.map((a) => [`bot:${a.name}`, a.name])] as const) {
    const file = avatarFile(home, name, agents);
    if (file) out[id] = `/avatar/${encodeURIComponent(name)}?v=${Math.floor(statSync(file).mtimeMs)}`;
  }
  return out;
}

/** agents.json, or no agents when it is missing or malformed: a picture is never worth failing the board. */
export function agentsOrNone(home: string): Agent[] {
  try {
    return loadAgents(home);
  } catch {
    return [];
  }
}

/** GET /avatar/<name>: the picture with its image type, or 404. */
export function avatarResponse(home: string, segment: string): Response {
  let name = "";
  try {
    name = decodeURIComponent(segment);
  } catch {}
  const file = avatarFile(home, name, agentsOrNone(home));
  if (!file) return new Response("not found\n", { status: 404 });
  return new Response(Bun.file(file), {
    headers: {
      "content-type": TYPES[extname(file).toLowerCase()]!,
      "x-content-type-options": "nosniff",
      "cache-control": "max-age=86400",
    },
  });
}

const onHost = (exec: Exec, a: Agent, cmd: string) =>
  a.host === "" ? exec("sh", ["-c", cmd]) : exec("ssh", [a.host, cmd]);

/**
 * The bot's Discord account picture. The token is read and used on the bot's own machine (GET /users/@me only); only
 * the public picture id comes back, and the picture itself is a public CDN file.
 */
async function discordPicture(exec: Exec, a: Agent, get: typeof fetch): Promise<Uint8Array | null> {
  const env = `$HOME/.hermes/profiles/${a.profile}/.env`;
  const cmd = `t=$(grep -m1 '^DISCORD_BOT_TOKEN=' "${env}" 2>/dev/null | cut -d= -f2- | tr -d "\\"'"); [ -n "$t" ] && curl -fsS -m 10 -H "Authorization: Bot $t" https://discord.com/api/v10/users/@me`;
  const r = await onHost(exec, a, cmd).catch(() => null);
  if (!r || r.code !== 0) return null;
  let me: { id?: unknown; avatar?: unknown };
  try {
    me = JSON.parse(r.stdout) as typeof me;
  } catch {
    return null;
  }
  if (typeof me.id !== "string" || typeof me.avatar !== "string" || !/^\w+$/.test(me.id + me.avatar)) return null;
  const res = await get(`https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=256`).catch(() => null);
  return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/** The hermes profile's assets/avatar.png, read on the bot's machine. */
async function profilePicture(exec: Exec, a: Agent): Promise<Uint8Array | null> {
  const r = await onHost(exec, a, `base64 < "$HOME/.hermes/profiles/${a.profile}/assets/avatar.png"`).catch(() => null);
  return r && r.code === 0 && r.stdout.trim() ? new Uint8Array(Buffer.from(r.stdout, "base64")) : null;
}

/** `dori agents avatars`: saves each bot's picture to DORI_HOME/avatars/<name>.png; one line per bot. */
export async function syncAvatars(
  exec: Exec,
  home: string,
  agents: Agent[],
  get: typeof fetch = fetch,
): Promise<string[]> {
  mkdirSync(dir(home), { recursive: true });
  const lines: string[] = [];
  for (const a of agents) {
    const discord = await discordPicture(exec, a, get);
    const picture = discord ?? (await profilePicture(exec, a));
    if (!picture || picture.length > MAX_BYTES) {
      lines.push(`NO_AVATAR ${a.name}`);
      continue;
    }
    writeFileSync(join(dir(home), `${a.name}.png`), picture);
    lines.push(`AVATAR ${a.name} ${discord ? "discord" : "profile"}`);
  }
  return lines;
}
