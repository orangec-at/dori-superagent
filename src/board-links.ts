import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type { Agent } from "./agents.ts";
import { agentsOrNone } from "./board-avatars.ts";
import { hermesScript, OMO_SCRIPT, parseHermes, parseOmo } from "./board-links-read.ts";
import { boardRepo } from "./loop-board.ts";
import type { Exec, ExecOptions } from "./runtime/exec.ts";
import { isOn, leadState, loadLeads, type StandingLead } from "./standing.ts";
import type { Store } from "./store.ts";

/**
 * The board's connection map: who runs where, on which CLI and model, and over which channels the operator, the lead,
 * its lanes and the bots reach each other. The hourly loop (refreshLinks) and `dori agents map` collect it into
 * DORI_HOME/board-links.json and the board only reads that file. Other machines are read over ssh, read-only. Only names leave a machine: a model and provider
 * name, whether a channel's credential is set (never its value), never a token, key, webhook URL or channel id.
 */

/** Seen from the actor: `in` comes to it, `out` goes from it, `both` either way. */
export type LinkDir = "both" | "in" | "out";
export type LinkChannel = { name: string; with: string; dir: LinkDir };
export type LinkKind = "lead" | "duty" | "standing" | "lane" | "bot";
export type LinkActor = {
  /** The board row id (`lead`, `bot:<name>`, `lane:<key>`, `standing:<domain>`) or `duty`. */
  id: string;
  kind: LinkKind;
  label: string;
  computer: string;
  cli: string;
  /** null: not readable, shown as 알 수 없음. */
  provider: string | null;
  model: string | null;
  /** Where provider and model were read. */
  source: string;
  /** The actors that hand it work, and how. */
  from: string[];
  via: string | null;
  channels: LinkChannel[];
};
export type LinkSnapshot = { generatedAt: number; actors: LinkActor[]; unknown: string[] };

export const UNKNOWN = "알 수 없음";
const OPERATOR = "재일 님";
const LEAD = "도리도라";
const linksPath = (home: string): string => join(home, "board-links.json");

/** The machine's name in the map: an ssh destination without its user (`mac@mac-macmini` -> mac-macmini). */
export const computerOf = (host: string, local: string): string => (host === "" ? local : host.replace(/^.*@/, ""));

type Run = (host: string, script: string) => Promise<string | null>;
const runner =
  (exec: Exec, onSpawn?: ExecOptions["onSpawn"]): Run =>
  async (host, script) => {
    const argv = host === "" ? ["-c", script] : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, script];
    const r = await exec(host === "" ? "sh" : "ssh", argv, onSpawn ? { onSpawn } : undefined).catch(() => null);
    return r && r.code === 0 ? r.stdout : null;
  };

const BOT_CHANNELS: [string, LinkChannel][] = [
  ["DISCORD_BOT_TOKEN", { name: "Discord 봇 (DM·서버)", with: OPERATOR, dir: "both" }],
  ["SLACK_BOT_TOKEN", { name: "Slack 봇", with: OPERATOR, dir: "both" }],
  ["TELEGRAM_BOT_TOKEN", { name: "Telegram 봇", with: OPERATOR, dir: "both" }],
  ["GH_TOKEN", { name: "GitHub (gh)", with: "GitHub", dir: "out" }],
  ["TEAM_BOARD", { name: "GitHub 이슈 (team-board)", with: LEAD, dir: "both" }],
];

/** The lead's channels: its front ends in DORI_HOME/bin and the board itself, names only. */
function leadChannels(home: string): LinkChannel[] {
  const bin = (f: string): boolean => existsSync(join(home, "bin", f));
  const repo = boardRepo(home);
  return [
    ...(bin("dori-reply") || existsSync(join(home, "discord"))
      ? [{ name: "Discord DM", with: OPERATOR, dir: "both" } as const]
      : []),
    ...(bin("dori-notify") ? [{ name: "Discord 알림", with: OPERATOR, dir: "out" } as const] : []),
    ...(bin("dori-slack-reply") ? [{ name: "Slack 스레드", with: OPERATOR, dir: "both" } as const] : []),
    { name: "보드 대화", with: OPERATOR, dir: "both" },
    ...(bin("dori-muse-reply") ? [{ name: "Muse 요청", with: "Muse", dir: "both" } as const] : []),
    ...(repo ? [{ name: `GitHub 이슈 (${repo.split("/").pop()})`, with: "봇", dir: "both" } as const] : []),
  ];
}

/** A standing lead's own Discord threads, by name from its rules (`#fmv approval thread 123` -> Discord #fmv 스레드). */
const ruleThreads = (l: StandingLead): LinkChannel[] =>
  [...new Set(l.rules.flatMap((r) => [...r.matchAll(/#([a-z][\w-]*)\b[^.]*?\bthread/gi)].map((m) => m[1]!)))].map(
    (c) => ({ name: `Discord #${c} 스레드`, with: OPERATOR, dir: "both" }),
  );

function standingLeads(home: string): StandingLead[] {
  try {
    return loadLeads(home).filter((l) => isOn(leadState(home, l.domain)));
  } catch {
    return [];
  }
}

/** `onSpawn` gets every sh/ssh process it starts, so a caller that gives up can kill them. */
export type CollectOptions = { now: number; agentCmd: string; local?: string; onSpawn?: ExecOptions["onSpawn"] };

/** Reads every actor's machine once and returns the map; nothing is written. */
export async function collectLinks(exec: Exec, store: Store, o: CollectOptions): Promise<LinkSnapshot> {
  const run = runner(exec, o.onSpawn);
  const home = store.root;
  const local = o.local ?? hostname().split(".")[0]!;
  const cli = basename(o.agentCmd.split(" ")[0] ?? o.agentCmd);
  const omoOn = new Map<string, Promise<{ provider: string | null; model: string | null }>>();
  const omo = (machine: string) => {
    if (cli !== "omo") return Promise.resolve({ provider: null, model: null });
    const known = omoOn.get(machine);
    if (known) return known;
    const p = run(machine, OMO_SCRIPT).then(parseOmo);
    omoOn.set(machine, p);
    return p;
  };
  const omoSource = `${cli} 기본 설정 (~/.omo/agent/settings.json)`;
  const session = async (
    a: Omit<LinkActor, "provider" | "model" | "source" | "cli" | "computer">,
    machine = "",
    runtime = "herdr",
  ): Promise<LinkActor> => ({
    ...a,
    computer: computerOf(machine, local),
    cli: `${cli} · ${runtime}`,
    ...(await omo(machine)),
    source: omoSource,
  });

  const standing = standingLeads(home);
  const lanes = store.lanes().filter((l) => l.status !== "done");
  const agents: Agent[] = agentsOrNone(home);
  const roles = (() => {
    try {
      return JSON.parse(readFileSync(join(home, "roles.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const actors = await Promise.all([
    session({ id: "lead", kind: "lead", label: `${LEAD} (lead)`, from: [], via: null, channels: leadChannels(home) }),
    ...(roles["duty"]
      ? [
          session({
            id: "duty",
            kind: "duty",
            label: "duty (당번)",
            from: [],
            via: null,
            channels: [
              { name: "nudge", with: "lane", dir: "out" },
              { name: "dori send", with: LEAD, dir: "out" },
            ],
          }),
        ]
      : []),
    ...standing.map((l) =>
      session({
        id: `standing:${l.domain}`,
        kind: "standing",
        label: `${l.domain} lead`,
        from: ["lead"],
        via: "dori lead",
        channels: [{ name: "dori send", with: LEAD, dir: "both" }, ...ruleThreads(l)],
      }),
    ),
    ...lanes.map((l) =>
      session(
        {
          id: `lane:${l.key}`,
          kind: "lane",
          label: l.key,
          from: ["lead"],
          via: "dori start · send",
          channels: [
            { name: "dori report·ready", with: LEAD, dir: "out" },
            { name: "dori send", with: LEAD, dir: "in" },
          ],
        },
        l.sessionRef.machine ?? "",
        l.sessionRef.runtime,
      ),
    ),
    ...agents.map(async (a): Promise<LinkActor> => {
      const h = parseHermes(await run(a.host, hermesScript(a.profile)));
      return {
        id: `bot:${a.name}`,
        kind: "bot",
        label: /^([^(:]+)\(/.exec(a.description)?.[1]?.trim() || a.name,
        computer: computerOf(a.host, local),
        cli: "hermes",
        provider: h?.provider ?? null,
        model: h?.model ?? null,
        source:
          h === null ? "ssh로 읽지 못함" : h.found ? `hermes 프로필 ${a.profile} config.yaml` : "hermes 프로필 없음",
        from: ["lead", ...standing.filter((l) => l.bots.includes(a.name)).map((l) => `standing:${l.domain}`)],
        via: a.host === "" ? "dori delegate" : "dori delegate (ssh)",
        channels: BOT_CHANNELS.filter(([k]) => h?.has.has(k)).map(([, c]) => c),
      };
    }),
  ]);
  const unknown = actors.flatMap((a) => {
    const missing = [a.provider ? "" : "provider", a.model ? "" : "모델"].filter(Boolean);
    return missing.length ? [`${a.label}: ${missing.join("·")} (${a.source})`] : [];
  });
  return { generatedAt: o.now, actors, unknown };
}

export function saveLinks(home: string, s: LinkSnapshot): string {
  const path = linksPath(home);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

/** The last collected map, or null when it was never collected or cannot be read. */
export function readLinks(home: string): LinkSnapshot | null {
  try {
    const v = JSON.parse(readFileSync(linksPath(home), "utf8")) as LinkSnapshot;
    return Array.isArray(v.actors) && typeof v.generatedAt === "number" ? v : null;
  } catch {
    return null;
  }
}
