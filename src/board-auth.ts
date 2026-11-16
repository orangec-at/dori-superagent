import { type AccessResult, accessVerifier, type CertFetch } from "./board-access.ts";
import type { BoardConfig } from "./board-config.ts";

/** Only loopback: the board is reached through `tailscale serve` or cloudflared, which proxy to 127.0.0.1. */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOGIN_HEADER = "tailscale-user-login";
/**
 * The requesting device: tailscale serve replaces X-Forwarded-For with the tailnet source IP (a value the client sent is
 * dropped; X-Real-IP is passed through as sent, so it is never read).
 */
const NODE_HEADER = "x-forwarded-for";
/** Set by Cloudflare Access on every request it lets through to the tunnel; cloudflared refuses requests without it. */
const ACCESS_HEADER = "cf-access-jwt-assertion";

/** Who may write, and the Origin a same-origin post from their page carries. */
export type Writer = { id: string; origin: string };
export type Denied = { code: string; why: string };

export const hostnameOf = (req: Request): string =>
  (req.headers.get("host") ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

/**
 * The two ways to write. Through Cloudflare Access (the request carries its JWT): a valid token for an allowed email;
 * cloudflared rewrites Host to localhost, so the Origin must be the configured tunnel origin. Through the tailnet: an
 * allowed login on an allowed device, at a tailnet Host (never loopback), posting from `https://<that host>`.
 */
export function boardAuth(config: BoardConfig, o: { now: () => number; fetchCerts?: CertFetch }) {
  const verify: ((token: string) => Promise<AccessResult>) | null = config.access
    ? accessVerifier(config.access, o)
    : null;
  const knownHost = (name: string): boolean =>
    LOOPBACK_HOSTS.has(name) || name.endsWith(".ts.net") || config.hosts.includes(name);
  const allowedLogin = (req: Request): string | null => {
    const login = req.headers.get(LOGIN_HEADER)?.trim() ?? "";
    return login !== "" && config.allow.includes(login) ? login : null;
  };
  // A single IP on the allowNodes list; a missing or chained X-Forwarded-For identifies no device.
  const allowedNode = (req: Request): boolean => {
    const node = req.headers.get(NODE_HEADER)?.trim() ?? "";
    return node !== "" && !node.includes(",") && config.allowNodes.includes(node);
  };

  async function writer(req: Request): Promise<Writer | Denied> {
    const jwt = req.headers.get(ACCESS_HEADER);
    if (jwt !== null && verify && config.access) {
      const r = await verify(jwt);
      if ("reason" in r) return { code: `access:${r.reason}`, why: `forbidden: Cloudflare Access ${r.reason}` };
      return { id: `access:${r.email}`, origin: config.access.origin };
    }
    const login = allowedLogin(req);
    if (!login) return { code: "login", why: "forbidden: not an allowed tailnet login" };
    if (!allowedNode(req)) return { code: "node", why: "forbidden: this device may not write to the board" };
    const host = req.headers.get("host") ?? "";
    const hostname = hostnameOf(req);
    if (host === "" || LOOPBACK_HOSTS.has(hostname) || !knownHost(hostname))
      return { code: "loopback", why: "forbidden: open the board through tailscale serve" };
    return { id: `tailnet:${login}`, origin: `https://${host}` };
  }

  return { knownHost, writer };
}
