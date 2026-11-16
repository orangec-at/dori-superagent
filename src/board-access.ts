import type { AccessConfig } from "./board-config.ts";

/** One key of the team's JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs). */
type Jwk = JsonWebKey & { kid?: string };
export type CertFetch = (url: string) => Promise<{ keys?: Jwk[] }>;
export type AccessResult = { email: string } | { reason: string };

/** Keys are re-read hourly, and at most once a minute when a token names a key id not seen yet (a key rotation). */
const KEY_TTL_MS = 3_600_000;
const UNKNOWN_KID_MS = 60_000;
/** Clock skew allowed on `nbf`; `exp` is checked exactly. */
const SKEW_S = 60;
const CERTS_TIMEOUT_MS = 5_000;

const fetchCerts: CertFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`certs answered ${res.status}`);
  return (await res.json()) as { keys?: Jwk[] };
};

const part = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Checks the `Cf-Access-Jwt-Assertion` Cloudflare Access puts on every request it lets through: an RS256 signature by
 * one of the team's current keys, the board application's `aud`, the team as `iss`, an `exp` in the future, and an
 * email on the allow list. Anything else is a reason, never an identity.
 */
export function accessVerifier(cfg: AccessConfig, o: { now: () => number; fetchCerts?: CertFetch }) {
  const issuer = `https://${cfg.teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const get = o.fetchCerts ?? fetchCerts;
  let keys = new Map<string, CryptoKey>();
  let checkedAt = Number.NEGATIVE_INFINITY;
  let lastError = "";
  let inflight: Promise<void> | null = null;

  async function load(): Promise<void> {
    checkedAt = o.now();
    try {
      const next = new Map<string, CryptoKey>();
      for (const k of (await get(certsUrl)).keys ?? []) {
        if (typeof k.kid !== "string" || k.kty !== "RSA") continue;
        const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        next.set(k.kid, await crypto.subtle.importKey("jwk", k, alg, false, ["verify"]));
      }
      keys = next;
      lastError = "";
    } catch (e) {
      // The keys already loaded stay in use; the reason is reported with the next token that needs a missing key.
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    const age = o.now() - checkedAt;
    if (age > KEY_TTL_MS || (!keys.has(kid) && age > UNKNOWN_KID_MS)) {
      inflight ??= load().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return keys.get(kid);
  }

  return async (token: string): Promise<AccessResult> => {
    const [h, p, s, extra] = token.split(".");
    if (!h || !p || !s || extra !== undefined) return { reason: "malformed" };
    const header = part(h);
    const claims = part(p);
    if (!header || !claims || header["alg"] !== "RS256" || typeof header["kid"] !== "string")
      return { reason: "malformed" };
    const key = await keyFor(header["kid"]);
    if (!key) return { reason: lastError ? `certs (${lastError})` : "unknown key" };
    const signed = new TextEncoder().encode(`${h}.${p}`);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(s, "base64url"), signed);
    if (!ok) return { reason: "signature" };
    const aud = claims["aud"];
    if (!(Array.isArray(aud) ? aud.includes(cfg.aud) : aud === cfg.aud)) return { reason: "aud" };
    if (claims["iss"] !== issuer) return { reason: "iss" };
    const nowS = o.now() / 1000;
    const exp = claims["exp"];
    if (typeof exp !== "number" || exp <= nowS) return { reason: "expired" };
    const nbf = claims["nbf"];
    if (typeof nbf === "number" && nbf > nowS + SKEW_S) return { reason: "not yet valid" };
    const email = typeof claims["email"] === "string" ? claims["email"].trim().toLowerCase() : "";
    if (email === "" || !cfg.allowEmails.includes(email)) return { reason: "email" };
    return { email };
  };
}
