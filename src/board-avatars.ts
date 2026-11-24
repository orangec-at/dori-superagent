import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Agent, loadAgents } from "./agents.ts";
import type { Exec } from "./runtime/exec.ts";

/**
 * Bot pictures on the board. The board shows agents.json `avatar` (a path inside DORI_HOME, relative to it or absolute),
 * else DORI_HOME/avatars/<name>.<png|jpg|jpeg|webp>; `lead` is the lead's own picture. A file that resolves outside
 * DORI_HOME (`..`, a symlink out) is never served. Without one a row keeps its letter circle. `dori agents avatars`
 * fills DORI_HOME/avatars: the bot's Discord account picture, else its hermes profile's assets/avatar.png.
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
/** The real path (symlinks resolved), or null when it does not exist (DORI_HOME not created yet, a file just removed). */
export const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
/** A real path is inside `realHome` (DORI_HOME's real path); `..foo.png` is a name inside. */
export const inHome = (realHome: string, real: string): boolean => {
  const rel = relative(realHome, real);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * The real path of a bot's (or `lead`'s) picture, or null: only an existing image file under 2 MB counts. The real
 * path is what gets opened, so a symlink swapped in after the check cannot point the board outside DORI_HOME.
 */
export function avatarFile(
  home: string,
  name: string,
  agents: Agent[],
  realHome: string | null = realOrNull(home),
): string | null {
  if (!realHome || !NAME.test(name)) return null;
  const given = agents.find((a) => a.name === name)?.avatar;
  const candidates = [
    ...(given ? [resolve(home, given)] : []),
    ...Object.keys(TYPES).map((ext) => join(dir(home), `${name}${ext}`)),
  ];
  for (const p of candidates) {
    if (!TYPES[extname(p).toLowerCase()]) continue;
    const real = realOrNull(p);
    if (!real || !TYPES[extname(real).toLowerCase()] || !inHome(realHome, real)) continue;
    const st = statSync(real, { throwIfNoEntry: false });
    if (st?.isFile() && st.size > 0 && st.size <= MAX_BYTES) return real;
  }
  return null;
}

/** Row id (`bot:<name>`, `lead`) -> the board URL of its picture, versioned by the file's mtime so a new one shows. */
export function avatarUrls(home: string, agents: Agent[]): Record<string, string> {
  const out: Record<string, string> = {};
  const realHome = realOrNull(home);
  if (!realHome) return out;
  for (const [id, name] of [["lead", "lead"], ...agents.map((a) => [`bot:${a.name}`, a.name])] as const) {
    const file = avatarFile(home, name, agents, realHome);
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
 * The bot's Discord account picture. The token is read and used on the bot's own machine (GET /users/@me only) and
 * reaches curl on stdin (`-H @-`), never its argv; only the public picture id comes back, and the picture itself is a
 * public CDN file.
 */
async function discordPicture(exec: Exec, a: Agent, get: typeof fetch): Promise<Uint8Array | null> {
  const env = `$HOME/.hermes/profiles/${a.profile}/.env`;
  const cmd = `t=$(grep -m1 '^DISCORD_BOT_TOKEN=' "${env}" 2>/dev/null | cut -d= -f2- | tr -d "\\"'"); [ -n "$t" ] && printf 'Authorization: Bot %s\\n' "$t" | curl -fsS -m 10 -H @- https://discord.com/api/v10/users/@me`;
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
