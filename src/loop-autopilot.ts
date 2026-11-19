// The hourly report's autopilot line: what the autopilot handed out, checked off and released in the last hour, and
// which projects it marked stalled, so the lead can see from the report alone whether bot hand-outs have stopped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotDir, autopilotStopped, readState } from "./autopilot-store.ts";
import { HOUR } from "./loop-audit.ts";
import { STALL_HOURS } from "./autopilot-stall.ts";

/**
 * `autopilot 1h: assigned N, completed N, failed N | stalled: a, b`, or undefined when assignments.jsonl is missing or
 * unreadable. Lines that are not an assignment (bad JSON, no numeric `at`, unknown `kind`) are skipped. A project is
 * stalled while its stall report is under STALL_HOURS old (one report a day).
 */
export function autopilotLine(home: string, now: number): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(autopilotDir(home), "assignments.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const n = { assigned: 0, completed: 0, failed: 0 };
  for (const line of text.split("\n")) {
    let a: { at?: unknown; kind?: unknown } | null;
    try {
      a = JSON.parse(line) as typeof a;
    } catch {
      continue;
    }
    if (a === null || typeof a !== "object" || typeof a.at !== "number" || a.at <= now - HOUR || a.at > now) continue;
    if (a.kind === "delegate" || a.kind === "backlog") n.assigned++;
    else if (a.kind === "completed") n.completed++;
    else if (a.kind === "release") n.failed++;
  }
  const stalled = Object.entries(readState(home).stallReportedAt)
    .filter(([, at]) => typeof at === "number" && now - at < STALL_HOURS * HOUR)
    .map(([project]) => project)
    .sort();
  return (
    `autopilot 1h${autopilotStopped(home) ? " (stopped)" : ""}: ` +
    `assigned ${n.assigned}, completed ${n.completed}, failed ${n.failed} | stalled: ${stalled.join(", ") || "none"}`
  );
}
