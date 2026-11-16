import { expect, test } from "bun:test";
import { accessVerifier, type CertFetch } from "../src/board-access.ts";
import type { AccessConfig } from "../src/board-config.ts";
import { CONFIG, NOW, post, start, tailnet } from "./board-setup.ts";

const TEAM = "team.cloudflareaccess.com";
const ACCESS: AccessConfig = {
  teamDomain: TEAM,
  aud: "f".repeat(64),
  allowEmails: ["op@example.com"],
  origin: "https://board.example.com",
};

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = `${b64({ alg: "RS256", kid, typ: "JWT", ...header })}.${b64(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head));
    return `${head}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { jwk, sign };
}

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [ACCESS.aud],
  iss: `https://${TEAM}`,
  email: "op@example.com",
  exp: NOW / 1000 + 600,
  iat: NOW / 1000 - 10,
  ...over,
});

/** A JWKS endpoint serving `keys`, counting how often it is read. */
function certs(keys: () => JsonWebKey[]) {
  const urls: string[] = [];
  const fetchCerts: CertFetch = async (url) => {
    urls.push(url);
    return { keys: keys() };
  };
  return { urls, fetchCerts };
}

test("a token signed by a team key for the board app and an allowed email is accepted; anything off is refused", async () => {
  const k = await keyPair("k1");
  const other = await keyPair("k1");
  const { urls, fetchCerts } = certs(() => [k.jwk]);
  const verify = accessVerifier(ACCESS, { now: () => NOW, fetchCerts });
  expect(await verify(await k.sign(claims()))).toEqual({ email: "op@example.com" });
  expect(await verify(await k.sign(claims({ email: "OP@example.com", aud: ACCESS.aud })))).toEqual({
    email: "op@example.com",
  });
  const cases: [string, string, string][] = [
    ["wrong aud", await k.sign(claims({ aud: ["another-app"] })), "aud"],
    ["expired", await k.sign(claims({ exp: NOW / 1000 - 1 })), "expired"],
    ["no exp", await k.sign(claims({ exp: undefined })), "expired"],
    ["signed by another key", await other.sign(claims()), "signature"],
    ["email not allowed", await k.sign(claims({ email: "someone@example.com" })), "email"],
    ["other team", await k.sign(claims({ iss: "https://evil.cloudflareaccess.com" })), "iss"],
    ["alg none", await k.sign(claims(), { alg: "none" }), "malformed"],
    ["garbage", "not-a-jwt", "malformed"],
  ];
  for (const [why, token, reason] of cases) expect([why, await verify(token)]).toEqual([why, { reason }]);
  expect(urls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
});

test("keys are cached, re-read hourly, and a rotated key id is fetched at most once a minute", async () => {
  const k1 = await keyPair("k1");
  const k2 = await keyPair("k2");
  let served = [k1.jwk];
  let now = NOW;
  const { urls, fetchCerts } = certs(() => served);
  const verify = accessVerifier(ACCESS, { now: () => now, fetchCerts });
  expect(await verify(await k1.sign(claims()))).toEqual({ email: "op@example.com" });
  expect(await verify(await k1.sign(claims()))).toEqual({ email: "op@example.com" });
  expect(urls).toHaveLength(1);
  const rotated = await k2.sign(claims({ exp: NOW / 1000 + 7200 }));
  expect(await verify(rotated)).toEqual({ reason: "unknown key" });
  expect(urls).toHaveLength(1);
  served = [k1.jwk, k2.jwk];
  now += 61_000;
  expect(await verify(rotated)).toEqual({ email: "op@example.com" });
  expect(urls).toHaveLength(2);
  served = [k2.jwk];
  now += 3_601_000;
  expect(await verify(await k1.sign(claims({ exp: now / 1000 + 60 })))).toEqual({ reason: "unknown key" });
  expect(urls).toHaveLength(3);
});

test("a certs endpoint that fails keeps the keys already loaded and names the failure", async () => {
  const k = await keyPair("k1");
  let fail = false;
  let now = NOW;
  const verify = accessVerifier(ACCESS, {
    now: () => now,
    fetchCerts: async () => {
      if (fail) throw new Error("certs answered 502");
      return { keys: [k.jwk] };
    },
  });
  expect(await verify(await k.sign(claims()))).toEqual({ email: "op@example.com" });
  fail = true;
  now += 3_601_000;
  expect(await verify(await k.sign(claims({ exp: now / 1000 + 60 })))).toEqual({ email: "op@example.com" });
  expect(await verify(await (await keyPair("k9")).sign(claims({ exp: now / 1000 + 60 })))).toEqual({
    reason: "certs (certs answered 502)",
  });
});

test("through the tunnel a valid Access token writes from the configured origin; a bad one keeps the board read-only", async () => {
  const k = await keyPair("k1");
  const { url, sent, logs } = start({
    config: { ...CONFIG, access: ACCESS },
    fetchCerts: async () => ({ keys: [k.jwk] }),
  });
  const tunnel = (jwt: string, over: Record<string, string> = {}) => ({
    host: "localhost",
    origin: ACCESS.origin,
    "cf-access-jwt-assertion": jwt,
    ...over,
  });
  const good = await k.sign(claims());
  const page = await (await fetch(`${url}/`, { headers: tunnel(good) })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "";
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  expect((await post(url, "/request", { csrf, text: "웹에서 보냄" }, tunnel(good))).status).toBe(303);
  expect(sent).toEqual(["[reply=board from=재일-board] 웹에서 보냄"]);

  const expired = await k.sign(claims({ exp: NOW / 1000 - 5 }));
  const readOnly = await (await fetch(`${url}/`, { headers: tunnel(expired) })).text();
  expect(readOnly).toContain("<fieldset disabled>");
  expect(readOnly).not.toMatch(/name="csrf" value="[0-9a-f]+"/);
  const refused: [string, Record<string, string>][] = [
    ["expired", tunnel(expired)],
    ["other email", tunnel(await k.sign(claims({ email: "x@example.com" })))],
    ["wrong origin", tunnel(good, { origin: "https://evil.example" })],
    ["no token", { host: "localhost", origin: ACCESS.origin }],
    ["tailnet csrf on the tunnel", tunnel(good)],
  ];
  for (const [why, headers] of refused) {
    const form = why.startsWith("tailnet") ? { csrf: "0".repeat(64), text: "x" } : { csrf, text: "x" };
    expect([why, (await post(url, "/request", form, headers)).status]).toEqual([why, 403]);
  }
  expect(sent).toHaveLength(1);
  expect(logs.filter((l) => l.includes(" 403 ")).map((l) => l.split(" ").at(-1))).toEqual([
    "access:expired",
    "access:email",
    "origin",
    "login",
    "csrf",
  ]);
  const tailnetCsrf = /name="csrf" value="([0-9a-f]+)"/.exec(
    await (await fetch(`${url}/`, { headers: tailnet() })).text(),
  );
  expect(tailnetCsrf?.[1]).not.toBe(csrf);
});
