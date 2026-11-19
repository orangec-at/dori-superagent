import { existsSync, readFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { type LeadRotationConfig, readSummarized, rotationLog, writeSummarized } from "./lead-rotate-state.ts";

/** The local calendar day of `ms` as `YYYY-MM-DD`. */
export const dayKey = (ms: number): string => {
  const t = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

/**
 * `daily` mode: once a day, one hooks.onLeadRotation line per earlier day that had rotations and was not summarized
 * yet (the first time, only yesterday), e.g. `[LEAD ROTATIONS] 2026-11-18: 16 lead rotations; rotations.log`.
 */
export function dailySummary(d: Deps, c: LeadRotationConfig, now: number): string[] {
  if (c.notify !== "daily") return [];
  const root = d.store.root;
  const today = dayKey(now);
  const yesterday = dayKey(now - 24 * 3_600_000);
  const through = readSummarized(root);
  if (through !== undefined && through >= yesterday) return [];
  const log = rotationLog(root);
  const counts = new Map<string, number>();
  for (const row of existsSync(log) ? readFileSync(log, "utf8").split("\n") : []) {
    const at = Date.parse(row.split(" ", 1)[0] ?? "");
    if (Number.isNaN(at) || !row.includes(" [LEAD ROTATED] ")) continue;
    const day = dayKey(at);
    if (day < today && (through === undefined ? day === yesterday : day > through))
      counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const lines = [...counts]
    .sort()
    .map(([day, n]) => `[LEAD ROTATIONS] ${day}: ${n} lead rotation${n === 1 ? "" : "s"}; ${log}`);
  for (const line of lines) void runHook(d, "onLeadRotation", { key: "lead", text: line, evidence: log });
  writeSummarized(root, yesterday);
  return lines;
}
