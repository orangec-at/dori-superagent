import { askAdd, askClose, askFor, asks, parseFor, parseOptions } from "./asks.ts";
import { serveBoard } from "./board.ts";
import { agentsOrNone } from "./board-avatars.ts";
import { GATEWAY_EVERY_MS, gatewayReader } from "./board-gateway.ts";
import { reusedProbe, runtimeLeadProbe } from "./board-lead-live.ts";
import { officeRemotes, REMOTE_EVERY_MS, remoteLeads } from "./board-office-remote.ts";
import { teamsLog } from "./board-office-teams.ts";
import { loadBoardConfig } from "./board-config.ts";
import { HUB_EVERY_MS, refreshHub } from "./board-hub.ts";
import { collectLinks } from "./board-links.ts";
import { saveLinks } from "./board-links-file.ts";
import type { ChannelSource } from "./channel-source.ts";
import { type Args, need, one, USAGE } from "./cli-args.ts";
import { discordCall, loadDiscordEnv } from "./discord-api.ts";
import { discordSync, TICK_MS } from "./discord-sync.ts";
import type { Deps } from "./harness.ts";
import { addDoc, docUrl, listDocs } from "./docs.ts";
import { send } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { slackCall, slackReply, slackReplyPath } from "./slack-api.ts";
import { slackSync } from "./slack-sync.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** `dori ask`, `dori board` and `dori doc`: the commands that feed the phone board. */
export const runBoardCommand = (d: Deps, a: Args, cmd: "ask" | "board" | "doc", x: string | undefined) =>
  cmd === "ask" ? runAsk(d, a, x) : cmd === "board" ? runBoard(d, a) : runDoc(d, a, x);

/**
 * `dori doc add <file.md> --title T [--project P] [--summary S] [--id ID]` puts a document on the board's 문서 tab and
 * prints `DOC <id> <link>`; `dori doc list` prints one line per document, newest first.
 */
export function runDoc(d: Deps, a: Args, x: string | undefined): number {
  const home = d.store.root;
  if (x === "list") {
    const all = listDocs(home);
    if (all.length === 0) console.log("NO_DOCS");
    for (const m of all)
      console.log(`${m.id} ${m.date}${m.project ? ` project=${m.project.replace(/\s+/g, "_")}` : ""} ${m.title}`);
    return 0;
  }
  if (x !== "add") throw new Refusal(`unknown doc command ${x ?? ""}\n\n${USAGE}`);
  const file = need(a.pos[2], "markdown file");
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    throw new Refusal(`cannot read ${file}`);
  }
  const [project, summary, id] = [one(a, "project"), one(a, "summary"), one(a, "id")];
  const doc = addDoc(
    home,
    source,
    {
      title: need(one(a, "title"), "--title"),
      name: basename(file),
      ...(project !== undefined ? { project } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(id !== undefined ? { id } : {}),
    },
    d.now(),
  );
  console.log(`DOC ${doc} ${docUrl(home, doc)}`);
  return 0;
}

/**
 * `dori ask <id> --question Q --option A=.. [--recommend A] [--link URL] [--for jaeil|bokyung] [--project P]`,
 * `dori ask close <id>`, `dori ask list`.
 */
export function runAsk(d: Deps, a: Args, x: string | undefined): number {
  const home = d.store.root;
  if (x === "list") {
    const all = asks(home).filter((k) => k.status === "open");
    if (all.length === 0) console.log("NO_ASKS");
    for (const k of all)
      console.log(
        `${k.id} for=${askFor(k)}${k.project ? ` project=${k.project.replace(/\s+/g, "_")}` : ""} ${k.sent ? `sent=${k.sent.choice}` : "unanswered"} ${k.question.replace(/\s+/g, " ")}`,
      );
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
  const project = one(a, "project");
  const ask = askAdd(home, id, {
    question: need(one(a, "question"), "--question"),
    options: parseOptions(a.flags.get("option") ?? []),
    ...(recommend !== undefined ? { recommend } : {}),
    ...(link !== undefined ? { link } : {}),
    for: parseFor(one(a, "for")),
    ...(project !== undefined ? { project } : {}),
    now: d.now(),
  });
  console.log(
    `ASKED ${ask.id} for=${askFor(ask)} options=${ask.options.map((o) => o.key).join(",")}${ask.recommend ? ` recommend=${ask.recommend}` : ""}`,
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
  const log = (l: string): void => console.log(l);
  const discord = env
    ? discordSync(d.store.root, discordCall(env.token), { now: d.now, users: env.users, log })
    : undefined;
  // Slack goes through dori-slack-reply's ssh host, where the bot token stays.
  const reply = slackReplyPath(d.store.root);
  const slack = reply ? slackSync(d.store.root, slackCall(), slackReply(reply), { now: d.now, log }) : undefined;
  const sources: ChannelSource[] = [];
  for (const [id, label, s] of [
    ["discord", "Discord", discord],
    ["slack", "Slack", slack],
  ] as const) {
    if (!s) continue;
    sources.push({ id, label, ...s });
    void s.tick();
    setInterval(() => void s.tick(), TICK_MS);
  }
  // PR states and project numbers are collected here, never on a page load or a poll.
  const hub = (): void => void refreshHub(d.exec, d.store, d.now()).then((l) => l && console.log(l));
  hub();
  setInterval(hub, HUB_EVERY_MS);
  // The other computers' leads are read over ssh here on a timer; a page load only reads the last answers.
  const remotes = remoteLeads(d.exec, officeRemotes(d.store.root), log);
  const lead = reusedProbe(
    runtimeLeadProbe((ref) => d.runtimes.for(ref), log),
    d.now,
  );
  void remotes.tick();
  setInterval(() => void remotes.tick(), REMOTE_EVERY_MS);
  // The bots' messenger turns, from each machine's hermes gateway (ssh for a bot with a host), the same way.
  const gateway = gatewayReader(d.exec, () => agentsOrNone(d.store.root), log);
  void gateway.tick();
  setInterval(() => void gateway.tick(), GATEWAY_EVERY_MS);
  const server = serveBoard(d.store, {
    sources,
    host: one(a, "host") ?? "127.0.0.1",
    port,
    now: d.now,
    config,
    toLead: (text) => send(d, "lead", text, "board"),
    office: { lead, remotes: remotes.seats, gateway: gateway.seen, teamsFailed: teamsLog(log) },
  });
  console.log(
    `BOARD ${server.url.href} home=${d.store.root} writers=${config.allow.length} devices=${config.allowNodes.length} access=${config.access ? config.access.allowEmails.length : "off"} copy=${config.copyTo || "off"} discord=${discord ? "on" : "off"} slack=${slack ? "on" : "off"}`,
  );
  return new Promise<number>(() => {});
}
