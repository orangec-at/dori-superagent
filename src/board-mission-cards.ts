import type { Agent } from "./agents.ts";
import { type BotCard, firstLine } from "./board-bots.ts";
import { firstUrl } from "./board-mission-sources.ts";
import type { Mission, MissionCard, MissionStatus } from "./board-mission-types.ts";
import { lanePrs } from "./board-prs.ts";
import { botStatus, NO_ASSIGNMENT, type StandingCard } from "./board-status.ts";
import { NUDGE_MINUTES } from "./duty.ts";
import { owns, type StandingLead } from "./standing.ts";
import type { Store } from "./store.ts";
import type { Lane } from "./store-types.ts";

const BOT_WORD: Record<string, MissionStatus> = { "진행 중": "진행", 결과: "완료", "배정 없음": "대기" };

/** Waiting on someone, cut off, or nudged until duty gave up on it. */
export const laneStuck = (l: Lane): boolean =>
  l.status === "waiting" || l.status === "lost" || (l.status === "working" && l.nudges >= NUDGE_MINUTES.length);

export type CardInput = {
  store: Store;
  agents: Agent[];
  leads: StandingLead[];
  bots: BotCard[];
  standing: StandingCard[];
  lanes: Lane[];
  missions: Mission[];
  now: number;
  titles: Map<string, string>;
  ownerLabel: (l: Lane) => string;
};

/** Each bot's role and today's assignment, each standing lead's domain and trial, each lane's brief; keyed by row id. */
export function missionCards(x: CardInput): Record<string, MissionCard> {
  const latest = (id: string): string | null => x.missions.find((m) => m.actors.some((a) => a.id === id))?.id ?? null;
  const cards: Record<string, MissionCard> = {};
  for (const b of x.bots) {
    const desc = x.agents.find((a) => a.name === b.name)?.description ?? "";
    cards[`bot:${b.name}`] = {
      role: `${b.role} · ${desc.replace(/^[^:]*:\s*/, "") || desc}`,
      note: null,
      mission: b.today && !NO_ASSIGNMENT.test(b.today) ? b.today : "오늘 배정 없음",
      status: BOT_WORD[botStatus(b, x.now)[2]] ?? "막힘",
      result: b.result ?? b.lastDelegate?.summary ?? null,
      href: firstUrl(b.result ?? ""),
      missionId: latest(`bot:${b.name}`),
    };
  }
  for (const c of x.standing) {
    const def = x.leads.find((d) => d.domain === c.domain);
    const done = x.lanes
      .filter((l) => l.final && def && owns(x.store, def, l.key))
      .sort((a, b) => b.final!.at - a.final!.at)[0];
    cards[`standing:${c.domain}`] = {
      role: `${c.domain} 도메인 리드${def ? ` · ${def.repos.join(", ")} · 봇 ${def.bots.join(", ")}` : ""}`,
      note: def?.rules[0] ?? null,
      mission: c.on
        ? `시범 ${def?.trialDays ?? "?"}일 중 ${c.trialDaysLeft}일 남음 · lane ${c.lanes}개 맡음`
        : (c.stopReason ?? "꺼져 있어요"),
      status: c.on ? (c.lanes ? "진행" : "대기") : c.stopReason ? "막힘" : "대기",
      result: done?.final ? `${done.key}: ${firstLine(done.final.text)}` : null,
      href: done?.final?.evidence[0] ?? null,
      missionId: latest(`standing:${c.domain}`),
    };
  }
  for (const l of x.lanes) {
    const pr = lanePrs(l).find((p) => p.url);
    cards[`lane:${l.key}`] = {
      role: `${x.ownerLabel(l)}가 맡긴 lane`,
      note: l.mission ? `미션 태그 ${l.mission}` : null,
      mission: x.titles.get(l.key) ?? l.key,
      status: laneStuck(l) ? "막힘" : l.status === "ready" || l.status === "done" ? "완료" : "진행",
      result: l.final ? firstLine(l.final.text) : null,
      href: l.final?.evidence[0] ?? pr?.url ?? null,
      missionId: latest(`lane:${l.key}`),
    };
  }
  return cards;
}
