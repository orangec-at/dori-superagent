import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { inHome, realOrNull } from "./board-avatars.ts";

/**
 * DORI_HOME/coupas-copy/posts.json: the 쿠파스 Threads posts the lead fills for the operator to copy into the Threads
 * app by hand. The board only reads it; what the operator marks as posted goes to posted.json beside it. Nothing here
 * talks to Threads, Muse or Discord.
 */

export type CoupasPost = {
  id: string;
  date: string;
  time: string;
  title: string;
  product: string;
  body: string;
  reply: string;
  video: string;
  aiLabel: boolean;
};
export type Posted = { postedAt: string; url: string };
/** `dropped`: posts left out because they did not have the shape above or repeated an id. */
export type CoupasRead = { updatedAt: string; posts: CoupasPost[]; posted: Record<string, Posted>; dropped: number };

type Out = {
  reject: (code: string, why: string, status: number) => Response;
  log: (line: string) => void;
  headers: Record<string, string>;
};

const URL_MAX = 500;
const NEEDED = ["id", "date", "time", "title", "body"] as const;
const OPTIONAL = ["product", "reply", "video"] as const;
const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

const dir = (home: string): string => join(home, "coupas-copy");
const str = (v: unknown): v is string => typeof v === "string";

function postOf(v: unknown): CoupasPost | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  const ok =
    NEEDED.every((k) => str(p[k])) &&
    OPTIONAL.every((k) => p[k] === undefined || str(p[k])) &&
    (p["aiLabel"] === undefined || typeof p["aiLabel"] === "boolean") &&
    p["id"] !== "";
  if (!ok) return null;
  const s = (k: string): string => (p[k] as string | undefined) ?? "";
  return {
    id: s("id"),
    date: s("date"),
    time: s("time"),
    title: s("title"),
    product: s("product"),
    body: s("body"),
    reply: s("reply"),
    video: s("video"),
    aiLabel: p["aiLabel"] === true,
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** posts.json as read, or null when it is missing, broken or has no `posts` list. */
function readPosts(home: string): Omit<CoupasRead, "posted"> | null {
  const v = readJson(join(dir(home), "posts.json")) as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v["posts"])) return null;
  const read = (v["posts"] as unknown[]).map(postOf);
  const seen = new Set<string>();
  const posts = read.filter((p): p is CoupasPost => p !== null && !seen.has(p.id) && Boolean(seen.add(p.id)));
  return { updatedAt: str(v["updatedAt"]) ? v["updatedAt"] : "", posts, dropped: read.length - posts.length };
}

/** posted.json: what the operator marked as posted; entries of another shape are left out. */
function readPosted(home: string): Record<string, Posted> {
  const v = readJson(join(dir(home), "posted.json"));
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).flatMap(([id, e]) => {
      const p = e as Record<string, unknown> | null;
      return p && str(p["postedAt"]) && str(p["url"]) ? [[id, { postedAt: p["postedAt"], url: p["url"] }]] : [];
    }),
  );
}

/** The 쿠파스 tab's data, or null when there is no posts.json to show. */
export function readCoupas(home: string): CoupasRead | null {
  const posts = readPosts(home);
  return posts ? { ...posts, posted: readPosted(home) } : null;
}

/**
 * POST /coupas, reached only after the board's writer, origin and CSRF checks passed: `posted` records when a post
 * went up (kept on a second press, which only changes the url) and its optional url, `undo` clears it. Only
 * posted.json is written; a post that is not in posts.json is refused.
 */
export function coupasPost(home: string, now: number, form: URLSearchParams, o: Out): Response {
  const id = form.get("id") ?? "";
  const action = form.get("action") ?? "";
  const url = (form.get("url") ?? "").trim();
  if (action !== "posted" && action !== "undo") return o.reject("action", "unknown coupas action", 400);
  if (url.length > URL_MAX) return o.reject("length", `url longer than ${URL_MAX} characters`, 413);
  if (url !== "" && !/^https?:\/\//i.test(url)) return o.reject("url", "the url must start with https://", 400);
  if (!readPosts(home)?.posts.some((p) => p.id === id)) return o.reject("post", "unknown post", 404);
  const all = readPosted(home);
  const was = all[id];
  const posted = Object.entries(all).filter(([k]) => k !== id);
  if (action === "posted") posted.push([id, { postedAt: was?.postedAt ?? new Date(now).toISOString(), url }]);
  const path = join(dir(home), "posted.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(Object.fromEntries(posted), null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  o.log(`BOARD_COUPAS ${action} ${id}`);
  return new Response(null, {
    status: 303,
    headers: { location: `/?tab=coupas&sent=coupas#cp-${encodeURIComponent(id)}`, ...o.headers },
  });
}

/**
 * GET /coupas/video?id=<id>: the video posts.json names for that post, found by id only. It is served only when its
 * real path (symlinks resolved) is a video file inside DORI_HOME/out/bido-video; anything else is 404.
 */
export function coupasVideo(home: string, id: string, headers: Record<string, string>): Response {
  const video = readPosts(home)?.posts.find((p) => p.id === id)?.video ?? "";
  const base = realOrNull(join(home, "out", "bido-video"));
  const real = video !== "" && isAbsolute(video) ? realOrNull(video) : null;
  const type = real ? VIDEO_TYPES[extname(real).toLowerCase()] : undefined;
  const ok = base && real && type && inHome(base, real) && statSync(real, { throwIfNoEntry: false })?.isFile();
  if (!ok || !real || !type)
    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", ...headers },
    });
  const name = `${id.replace(/[^A-Za-z0-9._-]/g, "_")}${extname(real).toLowerCase()}`;
  return new Response(Bun.file(real), {
    headers: { ...headers, "content-type": type, "content-disposition": `attachment; filename="${name}"` },
  });
}
