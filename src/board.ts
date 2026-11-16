import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Server } from "bun";
import { type Ask, markSent, openAsk } from "./asks.ts";
import type { CertFetch } from "./board-access.ts";
import { boardAuth, hostnameOf, LOOPBACK_HOSTS } from "./board-auth.ts";
import { avatarResponse } from "./board-avatars.ts";
import { appendChat } from "./board-chat.ts";
import { readLinks } from "./board-links.ts";
import { type BoardConfig, decideEnvelope, requestEnvelope } from "./board-config.ts";
import { boardHtml, REQUEST_MAX } from "./board-html.ts";
import { viewOf } from "./board-list-html.ts";
import { type BoardState, boardState } from "./board-state.ts";
import { rows } from "./board-status.ts";
import { threadOf } from "./board-thread.ts";
import { failureDetail } from "./delivery.ts";
import { PaneGone, Refusal } from "./refusal.ts";
import type { Store } from "./store.ts";

const BODY_MAX = 8 * 1024;
const VERSION_REUSE_MS = 2_000;

export type BoardOptions = {
  host: string;
  port: number;
  now: () => number;
  config: BoardConfig;
  /** Delivers one envelope to the lead's inbox (dori send lead). */
  toLead: (text: string) => Promise<string>;
  log?: (line: string) => void;
  /** Reads the Cloudflare Access team keys; tests pass their own. */
  fetchCerts?: CertFetch;
};

const STATIC: Record<string, [string, string]> = {
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/board.js": ["board.js", "text/javascript; charset=utf-8"],
};
const ASSETS = join(import.meta.dir, "..", "assets", "board");

const MANIFEST = {
  name: "도리 보드",
  short_name: "도리",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#111317",
  theme_color: "#111317",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // no-referrer would make the browser send `Origin: null` on the board's own form posts, failing the same-origin check.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

const text = (body: string, status: number): Response =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });

/**
 * Serves the phone board. Reads are open to anyone who reaches the loopback port (tailscale serve limits that to the
 * tailnet, Cloudflare Access to its allowed logins). A write (POST /decide, POST /request) is accepted only from a
 * writer board-auth.ts accepts, from that writer's own https origin, with the CSRF token bound to that writer. It only
 * delivers text to the lead and records it in the board's conversation: there is no merge, done or deploy path here.
 */
export function serveBoard(store: Store, o: BoardOptions): Server<undefined> {
  if (!LOOPBACK_HOSTS.has(o.host))
    throw new Refusal("dori board listens on loopback only; expose it with tailscale serve");
  const secret = randomBytes(32);
  const tokenFor = (id: string): string => createHmac("sha256", secret).update(id).digest("hex");
  const auth = boardAuth(o.config, { now: o.now, ...(o.fetchCerts ? { fetchCerts: o.fetchCerts } : {}) });
  const log = o.log ?? ((line: string) => console.log(line));
  const stamp = (): string => new Date(o.now()).toISOString();
  const reject = (kind: string, code: string, why: string, status: number): Response => {
    log(`BOARD_REJECT ${stamp()} ${kind} ${status} ${code}`);
    return text(why, status);
  };

  async function write(req: Request, kind: "decide" | "request"): Promise<Response> {
    const w = await auth.writer(req);
    if ("code" in w) return reject(kind, w.code, w.why, 403);
    if (req.headers.get("origin") !== w.origin) return reject(kind, "origin", "forbidden: cross-origin request", 403);
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") return reject(kind, "site", "forbidden: cross-site request", 403);
    if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
      return reject(kind, "type", "unsupported content type", 415);
    if (Number(req.headers.get("content-length") ?? "0") > BODY_MAX) return reject(kind, "size", "too large", 413);
    const raw = await req.text();
    if (raw.length > BODY_MAX) return reject(kind, "size", "too large", 413);
    const form = new URLSearchParams(raw);
    const given = Buffer.from(form.get("csrf") ?? "");
    const want = Buffer.from(tokenFor(w.id));
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return reject(kind, "csrf", "forbidden: stale page, reload the board", 403);

    const done = (flash: string, c = "lead"): Response =>
      new Response(null, {
        status: 303,
        headers: {
          location: kind === "request" ? `/?c=${encodeURIComponent(c)}&sent=${flash}#end` : `/?sent=${flash}`,
          ...SECURITY_HEADERS,
        },
      });
    let envelope: string;
    let said: string;
    let id = "";
    let choice = "";
    let thread = "lead";
    if (kind === "decide") {
      id = form.get("id") ?? "";
      choice = form.get("choice") ?? "";
      let ask: Ask;
      try {
        ask = openAsk(store.root, id, choice);
      } catch (e) {
        if (e instanceof Refusal) return reject(kind, "ask", e.message, 409);
        throw e;
      }
      // A double tap or a resubmitted form: the lead already has this answer.
      if (ask.sent?.choice === choice) {
        log(`BOARD_DUP ${stamp()} ${kind}`);
        return done(kind);
      }
      envelope = decideEnvelope(id, choice);
      said = `${id}: ${choice}. ${ask.options.find((x) => x.key === choice)?.text ?? ""}`.trim();
    } else {
      said = (form.get("text") ?? "").trim();
      if (said === "") return reject(kind, "empty", "empty request", 400);
      if (said.length > REQUEST_MAX)
        return reject(kind, "length", `request longer than ${REQUEST_MAX} characters`, 413);
      // A message written in a bot or lane conversation says which one it is about; the answer still comes to the lead's.
      const about = form.get("c") ?? "lead";
      const known = about !== "lead" && rows(boardState(store, o.now()), o.now()).some((r) => r.id === about);
      envelope = requestEnvelope(known ? `(${about}) ${said}` : said);
      if (known) thread = about;
    }
    let result: string;
    try {
      result = await o.toLead(envelope);
    } catch (e) {
      log(`BOARD_FAILED ${stamp()} ${kind} len=${envelope.length} ${failureDetail(e)}`);
      // Not a 5xx: Cloudflare would replace it with its own error page. Nothing was queued: the board asks to send again.
      if (!(e instanceof PaneGone)) return done("failed", thread);
      // The lead's pane is gone but the message waits in its inbox: like HELD, it must not be sent again.
      result = "HELD";
    }
    log(`BOARD_WRITE ${stamp()} ${kind} len=${envelope.length} ${result}`);
    appendChat(store.root, { at: o.now(), from: "operator", text: said, kind, delivery: result });
    // HELD: the delivery may not have reached the lead's pane (dori inbox ack/resend settles it), so the card must not
    // say sent and the operator is told to check instead.
    if (result === "HELD") return done("held");
    if (kind === "decide") {
      try {
        markSent(store.root, id, choice, o.now());
      } catch (e) {
        // The lead closed the ask while the answer was on its way: it was still delivered.
        if (!(e instanceof Refusal)) throw e;
      }
    }
    return done(result === "QUEUED" ? "queued" : kind);
  }

  /** What the page shows, without the clock: the page polls it and reloads when it changes. */
  const versionOf = (s: BoardState): string =>
    createHash("sha256")
      .update(JSON.stringify({ ...s, generatedAt: 0 }))
      .digest("hex")
      .slice(0, 16);
  // Every open tab polls /api/version; the answer is reused for a moment so polling cannot make the board re-read its files.
  let polled = { at: Number.NEGATIVE_INFINITY, v: "" };
  const polledVersion = (): string => {
    const now = o.now();
    if (now - polled.at >= VERSION_REUSE_MS) polled = { at: now, v: versionOf(boardState(store, now)) };
    return polled.v;
  };

  return Bun.serve({
    hostname: o.host,
    port: o.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") {
        if (!auth.knownHost(hostnameOf(req))) return reject("write", "host", "forbidden: unknown host", 403);
        if (url.pathname === "/decide") return write(req, "decide");
        if (url.pathname === "/request") return write(req, "request");
        return text("not found", 404);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return text("method not allowed", 405);
      if (!auth.knownHost(hostnameOf(req))) return reject("read", "host", "forbidden: unknown host", 403);
      if (url.pathname === "/") {
        const w = await auth.writer(req);
        const flash = url.searchParams.get("sent") ?? undefined;
        const now = o.now();
        const view = viewOf(url.searchParams);
        const state = boardState(store, now);
        const html = boardHtml(threadOf(store, state, view.c ?? "lead"), state, now, {
          token: "code" in w ? null : tokenFor(w.id),
          version: versionOf(state),
          view,
          links: view.tab === "map" ? readLinks(store.root) : null,
          ...(flash ? { flash } : {}),
        });
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
      }
      if (url.pathname === "/api/version") return Response.json({ v: polledVersion() }, { headers: SECURITY_HEADERS });
      if (url.pathname === "/api/board") {
        const w = await auth.writer(req);
        return "code" in w
          ? reject("read", w.code, w.why, 403)
          : Response.json(boardState(store, o.now()), { headers: SECURITY_HEADERS });
      }
      if (url.pathname.startsWith("/avatar/")) return avatarResponse(store.root, url.pathname.slice("/avatar/".length));
      if (url.pathname === "/manifest.webmanifest")
        return Response.json(MANIFEST, { headers: { "content-type": "application/manifest+json" } });
      const asset = STATIC[url.pathname];
      if (asset)
        return new Response(Bun.file(join(ASSETS, asset[0])), {
          headers: { "content-type": asset[1], "x-content-type-options": "nosniff" },
        });
      return text("not found", 404);
    },
  });
}
