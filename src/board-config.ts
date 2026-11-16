import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Cloudflare Access application in front of the board's tunnel: `teamDomain` (<team>.cloudflareaccess.com), the
 * application's `aud` tag, the Access login emails that may write, and `origin`, the https origin the board is opened
 * on through the tunnel (the Origin a same-origin form post carries).
 */
export type AccessConfig = { teamDomain: string; aud: string; allowEmails: string[]; origin: string };

/**
 * DORI_HOME/board.json: `allow`, the tailnet logins that may write; `allowNodes`, the tailnet IPs of the devices they
 * may write from (a bot on the operator's own machine carries the operator's login, so the login alone is not enough);
 * `access`, the Cloudflare Access writers (absent: the tunnel stays read-only); `copyTo`, an address (discord:<channel>)
 * that also gets every `dori reply board` answer; `hosts`, Host names served besides loopback and *.ts.net. Without the
 * file nobody can write: the defaults carry no person's account.
 */
export type BoardConfig = {
  allow: string[];
  allowNodes: string[];
  access: AccessConfig | null;
  copyTo: string;
  hosts: string[];
};
export const DEFAULT_BOARD: BoardConfig = { allow: [], allowNodes: [], access: null, copyTo: "", hosts: [] };

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** The `access` block when every field is usable; anything else leaves the tunnel read-only. */
function accessOf(v: unknown): AccessConfig | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const teamDomain = a["teamDomain"];
  const aud = a["aud"];
  const origin = a["origin"];
  const allowEmails = (strings(a["allowEmails"]) ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  if (typeof teamDomain !== "string" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) return null;
  if (typeof aud !== "string" || !/^[A-Za-z0-9]{16,128}$/.test(aud)) return null;
  if (typeof origin !== "string" || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) return null;
  return allowEmails.length > 0 ? { teamDomain, aud, allowEmails, origin } : null;
}

export function loadBoardConfig(home: string): BoardConfig {
  const path = join(home, "board.json");
  if (!existsSync(path)) return DEFAULT_BOARD;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const copyTo = raw["copyTo"];
  return {
    allow: strings(raw["allow"]) ?? DEFAULT_BOARD.allow,
    allowNodes: strings(raw["allowNodes"]) ?? DEFAULT_BOARD.allowNodes,
    access: accessOf(raw["access"]),
    copyTo: typeof copyTo === "string" && /^[a-z]+:[\w:./-]+$/.test(copyTo) ? copyTo : DEFAULT_BOARD.copyTo,
    hosts: strings(raw["hosts"]) ?? DEFAULT_BOARD.hosts,
  };
}

export const decideEnvelope = (id: string, choice: string): string => `[reply=board from=재일] decide ${id} ${choice}`;
/** A board request: the lead answers it with `dori reply board`, which lands in the board's conversation. */
export const requestEnvelope = (text: string): string => `[reply=board from=재일-board] ${text}`;
