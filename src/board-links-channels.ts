import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LinkActor, LinkChannel } from "./board-links.ts";
import type { HermesRead } from "./board-links-read.ts";
import { boardRepo } from "./loop-board.ts";
import type { StandingLead } from "./standing.ts";

/** Who talks to whom over what, for the connection map (board-links.ts): channel names only, never a credential. */

export const OPERATOR = "재일 님";
export const LEAD = "도리도라";

export const BOT_CHANNELS: [string, LinkChannel][] = [
  ["DISCORD_BOT_TOKEN", { name: "Discord 봇 (DM·서버)", with: OPERATOR, dir: "both" }],
  ["SLACK_BOT_TOKEN", { name: "Slack 봇", with: OPERATOR, dir: "both" }],
  ["TELEGRAM_BOT_TOKEN", { name: "Telegram 봇", with: OPERATOR, dir: "both" }],
  ["GH_TOKEN", { name: "GitHub (gh)", with: "GitHub", dir: "out" }],
  ["TEAM_BOARD", { name: "GitHub 이슈 (team-board)", with: LEAD, dir: "both" }],
];

/** The lead's channels: its front ends in DORI_HOME/bin and the board itself, names only. */
export function leadChannels(home: string): LinkChannel[] {
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
export const ruleThreads = (l: StandingLead): LinkChannel[] =>
  [...new Set(l.rules.flatMap((r) => [...r.matchAll(/#([a-z][\w-]*)\b[^.]*?\bthread/gi)].map((m) => m[1]!)))].map(
    (c) => ({ name: `Discord #${c} 스레드`, with: OPERATOR, dir: "both" }),
  );

const profileSource = (name: string): string =>
  name === "default" ? "hermes 기본 프로필 ~/.hermes config.yaml" : `hermes 프로필 ${name} config.yaml`;

/** A hermes profile agents.json does not list: a Slack relay when it holds a Slack bot token, else a bot nobody delegates to. */
export function unlistedProfile(name: string, h: HermesRead, computer: string, gateway: boolean): LinkActor {
  const base = { computer, cli: "hermes", provider: h.provider, model: h.model, source: profileSource(name), from: [] };
  const service = name === "default" && gateway ? "hermes-gateway.service" : null;
  if (h.has.has("SLACK_BOT_TOKEN"))
    return {
      ...base,
      id: `relay:${computer}:${name}`,
      kind: "relay",
      label: `Slack 중계 hermes${name === "default" ? "" : ` ${name}`} (${computer})`,
      via: service,
      channels: [
        { name: "Slack 스레드", with: OPERATOR, dir: "both" },
        { name: "중계", with: LEAD, dir: "out" },
      ],
    };
  return {
    ...base,
    id: `hermes:${computer}:${name}`,
    kind: "bot",
    label: `hermes ${name}`,
    via: service ?? "agents.json에 없음",
    channels: BOT_CHANNELS.filter(([k]) => h.has.has(k)).map(([, c]) => c),
  };
}
