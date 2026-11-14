import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { type Ask, markSent, openAsk } from "./asks.ts";
import { boardHtml, REQUEST_MAX } from "./board-html.ts";
import { boardState } from "./board-state.ts";
import { Refusal } from "./refusal.ts";
import type { Store } from "./store.ts";

/**
 * DORI_HOME/board.json: `allow`, the tailnet logins that may write; `allowNodes`, the tailnet IPs of the devices they
 * may write from (a bot on the operator's own machine carries the operator's login, so the login alone is not enough); `replyTo`, the address the lead answers a board
 * request on (discord:<channel>); `hosts`, Host names served besides loopback and *.ts.net. Without the file nobody
 * can write: the defaults carry no person's account.
 */
export type BoardConfig = { allow: string[]; allowNodes: string[]; replyTo: string; hosts: string[] };
export const DEFAULT_BOARD: BoardConfig = { allow: [], allowNodes: [], replyTo: "", hosts: [] };

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

export function loadBoardConfig(home: string): BoardConfig {
  const path = join(home, "board.json");
  if (!existsSync(path)) return DEFAULT_BOARD;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const replyTo = raw["replyTo"];
  return {
    allow: strings(raw["allow"]) ?? DEFAULT_BOARD.allow,
    allowNodes: strings(raw["allowNodes"]) ?? DEFAULT_BOARD.allowNodes,
    replyTo: typeof replyTo === "string" && /^[a-z]+:[\w:./-]+$/.test(replyTo) ? replyTo : DEFAULT_BOARD.replyTo,
    hosts: strings(raw["hosts"]) ?? DEFAULT_BOARD.hosts,
  };
}

export const decideEnvelope = (id: string, choice: string): string => `[reply=board from=재일] decide ${id} ${choice}`;
export const requestEnvelope = (replyTo: string, text: string): string => `[reply=${replyTo} from=재일-board] ${text}`;

/** Only loopback: the board is reached through `tailscale serve`, which proxies to 127.0.0.1 and adds the login header. */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const BODY_MAX = 8 * 1024;
const LOGIN_HEADER = "tailscale-user-login";
/**
 * The requesting device: tailscale serve replaces X-Forwarded-For with the tailnet source IP (a value the client sent is
 * dropped; X-Real-IP is passed through as sent, so it is never read).
 */
const NODE_HEADER = "x-forwarded-for";

export type BoardOptions = {
  host: string;
  port: number;
  now: () => number;
  config: BoardConfig;
  /** Delivers one envelope to the lead's inbox (dori send lead). */
  toLead: (text: string) => Promise<string>;
  log?: (line: string) => void;
};

const STATIC: Record<string, string> = {
  "/icon-180.png": "icon-180.png",
  "/icon-192.png": "icon-192.png",
  "/icon-512.png": "icon-512.png",
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
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // no-referrer would make the browser send `Origin: null` on the board's own form posts, failing the same-origin check.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

const text = (body: string, status: number): Response =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });

/**
 * Serves the phone board. Reads are open to anyone who reaches the loopback port (tailscale serve limits that to the
 * tailnet). A write (POST /decide, POST /request) is accepted only when all hold: the login header tailscale serve sets
 * is on the allow list, the Host is not a loopback address (a request straight to 127.0.0.1 is refused), Origin is the
 * same https origin, and the form carries the CSRF token bound to that login. It only delivers text to the lead: there
 * is no merge, done or deploy path here.
 */
export function serveBoard(store: Store, o: BoardOptions): Server<undefined> {
  if (!LOOPBACK_HOSTS.has(o.host))
    throw new Refusal("dori board listens on loopback only; expose it with tailscale serve");
  const secret = randomBytes(32);
  const tokenFor = (login: string): string => createHmac("sha256", secret).update(login).digest("hex");
  const log = o.log ?? ((line: string) => console.log(line));
  const stamp = (): string => new Date(o.now()).toISOString();
  const allowedLogin = (req: Request): string | null => {
    const login = req.headers.get(LOGIN_HEADER)?.trim() ?? "";
    return login !== "" && o.config.allow.includes(login) ? login : null;
  };
  // A single IP on the allowNodes list; a missing or chained X-Forwarded-For identifies no device.
  const allowedNode = (req: Request): boolean => {
    const node = req.headers.get(NODE_HEADER)?.trim() ?? "";
    return node !== "" && !node.includes(",") && o.config.allowNodes.includes(node);
  };
  // A Host that is neither loopback nor a tailnet name is a DNS-rebinding page in some browser: it gets nothing.
  const hostnameOf = (req: Request): string =>
    (req.headers.get("host") ?? "")
      .replace(/:\d+$/, "")
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  const knownHost = (name: string): boolean =>
    LOOPBACK_HOSTS.has(name) || name.endsWith(".ts.net") || o.config.hosts.includes(name);
  const reject = (kind: string, code: string, why: string, status: number): Response => {
    log(`BOARD_REJECT ${stamp()} ${kind} ${status} ${code}`);
    return text(why, status);
  };

  async function write(req: Request, kind: "decide" | "request"): Promise<Response> {
    const login = allowedLogin(req);
    if (!login) return reject(kind, "login", "forbidden: not an allowed tailnet login", 403);
    if (!allowedNode(req)) return reject(kind, "node", "forbidden: this device may not write to the board", 403);
    const host = req.headers.get("host") ?? "";
    const hostname = hostnameOf(req);
    if (host === "" || LOOPBACK_HOSTS.has(hostname) || !knownHost(hostname))
      return reject(kind, "loopback", "forbidden: open the board through tailscale serve", 403);
    if (req.headers.get("origin") !== `https://${host}`)
      return reject(kind, "origin", "forbidden: cross-origin request", 403);
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") return reject(kind, "site", "forbidden: cross-site request", 403);
    if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
      return reject(kind, "type", "unsupported content type", 415);
    if (Number(req.headers.get("content-length") ?? "0") > BODY_MAX) return reject(kind, "size", "too large", 413);
    const raw = await req.text();
    if (raw.length > BODY_MAX) return reject(kind, "size", "too large", 413);
    const form = new URLSearchParams(raw);
    const given = Buffer.from(form.get("csrf") ?? "");
    const want = Buffer.from(tokenFor(login));
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return reject(kind, "csrf", "forbidden: stale page, reload the board", 403);

    const done = (flash: string): Response =>
      new Response(null, { status: 303, headers: { location: `/?sent=${flash}`, ...SECURITY_HEADERS } });
    let envelope: string;
    let id = "";
    let choice = "";
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
    } else {
      const body = (form.get("text") ?? "").trim();
      if (body === "") return reject(kind, "empty", "empty request", 400);
      if (body.length > REQUEST_MAX)
        return reject(kind, "length", `request longer than ${REQUEST_MAX} characters`, 413);
      if (o.config.replyTo === "") return reject(kind, "config", "board.json has no replyTo for requests", 503);
      envelope = requestEnvelope(o.config.replyTo, body);
    }
    let result: string;
    try {
      result = await o.toLead(envelope);
    } catch (e) {
      log(`BOARD_FAILED ${stamp()} ${kind} len=${envelope.length}`);
      return text(`could not reach the lead: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
    log(`BOARD_WRITE ${stamp()} ${kind} len=${envelope.length} ${result}`);
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

  return Bun.serve({
    hostname: o.host,
    port: o.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") {
        if (!knownHost(hostnameOf(req))) return reject("write", "host", "forbidden: unknown host", 403);
        if (url.pathname === "/decide") return write(req, "decide");
        if (url.pathname === "/request") return write(req, "request");
        return text("not found", 404);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return text("method not allowed", 405);
      if (!knownHost(hostnameOf(req))) return reject("read", "host", "forbidden: unknown host", 403);
      if (url.pathname === "/") {
        const login = allowedLogin(req);
        const flash = url.searchParams.get("sent") ?? undefined;
        const html = boardHtml(boardState(store, o.now()), {
          token: login && allowedNode(req) ? tokenFor(login) : null,
          ...(flash ? { flash } : {}),
        });
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
      }
      if (url.pathname === "/api/board")
        return allowedLogin(req)
          ? Response.json(boardState(store, o.now()), { headers: SECURITY_HEADERS })
          : reject("read", "login", "forbidden: not an allowed tailnet login", 403);
      if (url.pathname === "/manifest.webmanifest")
        return Response.json(MANIFEST, { headers: { "content-type": "application/manifest+json" } });
      const asset = STATIC[url.pathname];
      if (asset) return new Response(Bun.file(join(ASSETS, asset)), { headers: { "content-type": "image/png" } });
      return text("not found", 404);
    },
  });
}
