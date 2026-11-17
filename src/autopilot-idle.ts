// What the lead is told when an idle bot has nothing left to hand out (autopilot.ts, docs/autopilot.md).
import { join } from "node:path";
import { STALL_HOURS } from "./autopilot-stall.ts";
import { projectsDir, type Roadmap } from "./roadmap.ts";

/**
 * The lead's line for an idle bot with nothing left to hand out, naming the roadmaps it works on (or projects/*.md), or
 * undefined when that bot was already reported within STALL_HOURS. Records the report in `reportedAt`.
 */
export function noWorkReport(
  home: string,
  roadmaps: readonly Roadmap[],
  bot: string,
  idle: string,
  now: number,
  reportedAt: Record<string, number>,
): string | undefined {
  const last = reportedAt[bot];
  if (last !== undefined && now - last < STALL_HOURS * 3_600_000) return undefined;
  reportedAt[bot] = now;
  const own = roadmaps.filter((r) => r.owners.includes(bot) || r.tasks.some((t) => t.bot === bot)).map((r) => r.file);
  const files = own.length ? own.join(", ") : join(projectsDir(home), "*.md");
  return `[REPORT autopilot] ${bot} 유휴 ${idle}: 맡길 일 없음 → ${files}에 추가해 주세요`;
}
