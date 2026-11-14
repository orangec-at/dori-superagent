import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { askAdd } from "../src/asks.ts";
import { type BoardConfig, serveBoard } from "../src/board.ts";
import { Store } from "../src/store.ts";

export const NOW = Date.UTC(2026, 10, 13, 1, 0, 0);
export const LOGIN = "operator@example.com";
export const HOST = "board.example.ts.net:8446";
export const PHONE = "100.64.0.10";
export const BOT_MACHINE = "100.64.0.20";
export const CONFIG: BoardConfig = { allow: [LOGIN], allowNodes: [PHONE], replyTo: "discord:100200300", hosts: [] };
const servers: Server<undefined>[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A board on a fresh DORI_HOME with one open ask (vg-analytics, A recommended); every lead delivery is recorded. */
export function start(o: { toLead?: (text: string) => Promise<string>; config?: BoardConfig } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dori-board-"));
  roots.push(root);
  const store = new Store(root);
  askAdd(root, "vg-analytics", {
    question: "분석 도구는?",
    options: [
      { key: "A", text: "Umami <b>무료</b>" },
      { key: "B", text: "Plausible" },
    ],
    recommend: "A",
    now: NOW - 60_000,
  });
  const sent: string[] = [];
  const logs: string[] = [];
  const server = serveBoard(store, {
    host: "127.0.0.1",
    port: 0,
    now: () => NOW,
    config: o.config ?? CONFIG,
    toLead:
      o.toLead ??
      (async (text) => {
        sent.push(text);
        return "DELIVERED";
      }),
    log: (l) => logs.push(l),
  });
  servers.push(server);
  return { url: server.url.href.replace(/\/$/, ""), sent, logs, home: root, store };
}

/** The headers tailscale serve forwards for the allowed operator on their phone, at the tailnet address. */
export const tailnet = (over: Record<string, string> = {}): Record<string, string> => ({
  host: HOST,
  origin: `https://${HOST}`,
  "tailscale-user-login": LOGIN,
  "x-forwarded-for": PHONE,
  ...over,
});

export const tokenOf = async (url: string): Promise<string> => {
  const html = await (await fetch(`${url}/`, { headers: tailnet() })).text();
  return /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
};

export const post = (url: string, path: string, form: Record<string, string>, headers: Record<string, string>) =>
  fetch(`${url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
