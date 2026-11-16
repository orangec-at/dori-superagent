import { askAdd, askClose, asks, parseOptions } from "./asks.ts";
import { serveBoard } from "./board.ts";
import { loadBoardConfig } from "./board-config.ts";
import { HUB_EVERY_MS, refreshHub } from "./board-hub.ts";
import { collectLinks } from "./board-links.ts";
import { saveLinks } from "./board-links-file.ts";
import { type Args, need, one } from "./cli-args.ts";
import { discordCall, loadDiscordEnv } from "./discord-api.ts";
import { discordSync, TICK_MS } from "./discord-sync.ts";
import type { Deps } from "./harness.ts";
import { send } from "./inbox.ts";
import { Refusal } from "./refusal.ts";

/** `dori ask <id> --question Q --option A=.. [--recommend A] [--link URL]`, `dori ask close <id>`, `dori ask list`. */
export function runAsk(d: Deps, a: Args, x: string | undefined): number {
  const home = d.store.root;
  if (x === "list") {
    const all = asks(home).filter((k) => k.status === "open");
    if (all.length === 0) console.log("NO_ASKS");
    for (const k of all)
      console.log(`${k.id} ${k.sent ? `sent=${k.sent.choice}` : "unanswered"} ${k.question.replace(/\s+/g, " ")}`);
    return 0;
  }
  if (x === "close") {
    const id = need(a.pos[2], "ask id");
    askClose(home, id, d.now());
    console.log(`ASK_CLOSED ${id}`);
    return 0;
  }
  const id = need(x, "ask id");
  const recommend = one(a, "recommend");
  const link = one(a, "link");
  const ask = askAdd(home, id, {
    question: need(one(a, "question"), "--question"),
    options: parseOptions(a.flags.get("option") ?? []),
    ...(recommend !== undefined ? { recommend } : {}),
    ...(link !== undefined ? { link } : {}),
    now: d.now(),
  });
  console.log(
    `ASKED ${ask.id} options=${ask.options.map((o) => o.key).join(",")}${ask.recommend ? ` recommend=${ask.recommend}` : ""}`,
  );
  return 0;
}

/** `dori agents map`: collects the board's connection map into DORI_HOME/board-links.json; one UNKNOWN line per gap. */
export async function runLinks(d: Deps): Promise<number> {
  const s = await collectLinks(d.exec, d.store, { now: d.now(), agentCmd: d.agentCmd });
  console.log(`LINKS ${saveLinks(d.store.root, s)} actors=${s.actors.length} unknown=${s.unknown.length}`);
  for (const u of s.unknown) console.log(`UNKNOWN ${u}`);
  return 0;
}

/** `dori board [--port 7401] [--host 127.0.0.1]`: the phone board, writes delivered to the lead with `dori send lead`. */
export function runBoard(d: Deps, a: Args): Promise<number> {
  const port = Number(one(a, "port") ?? "7401");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refusal("--port must be 0-65535");
  const config = loadBoardConfig(d.store.root);
  const env = loadDiscordEnv(d.store.root);
  const discord = env
    ? discordSync(d.store.root, discordCall(env.token), { now: d.now, users: env.users, log: (l) => console.log(l) })
    : undefined;
  if (discord) {
    void discord.tick();
    setInterval(() => void discord.tick(), TICK_MS);
  }
  // PR states and project numbers are collected here, never on a page load or a poll.
  const hub = (): void => void refreshHub(d.exec, d.store, d.now()).then((l) => l && console.log(l));
  hub();
  setInterval(hub, HUB_EVERY_MS);
  const server = serveBoard(d.store, {
    ...(discord ? { discord } : {}),
    host: one(a, "host") ?? "127.0.0.1",
    port,
    now: d.now,
    config,
    toLead: (text) => send(d, "lead", text, "board"),
  });
  console.log(
    `BOARD ${server.url.href} home=${d.store.root} writers=${config.allow.length} devices=${config.allowNodes.length} access=${config.access ? config.access.allowEmails.length : "off"} copy=${config.copyTo || "off"} discord=${discord ? "on" : "off"}`,
  );
  return new Promise<number>(() => {});
}
