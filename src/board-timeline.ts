import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DORI_HOME/timelines/<project>.json: a project's features and the stage each one is at. The lead edits the file by
 * hand; the board only reads it, for the 일정 tab.
 */

export const TIMELINE_STATES = ["진행", "대기", "보류"] as const;
export type TimelineState = (typeof TIMELINE_STATES)[number];
/** One feature; `stage` is null when the file names a stage that is not in `stages` (shown as 단계 미정). */
export type TimelineItem = {
  id: string;
  name: string;
  stage: string | null;
  state: TimelineState;
  size: string;
  next: string;
  owner: string;
  target: string;
  link: string;
};
/** `dropped`: how many items were left out because they did not have the shape above. */
export type Timeline = {
  project: string;
  title: string;
  updatedAt: string;
  stages: string[];
  note: string;
  items: TimelineItem[];
  dropped: number;
};

const str = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown): boolean => v === undefined || str(v);

function itemOf(v: unknown, stages: string[]): TimelineItem | null {
  if (typeof v !== "object" || v === null) return null;
  const i = v as Record<string, unknown>;
  const ok =
    [i["id"], i["name"], i["stage"], i["next"], i["owner"], i["target"]].every(str) &&
    TIMELINE_STATES.includes(i["state"] as TimelineState) &&
    optStr(i["size"]) &&
    optStr(i["link"]);
  if (!ok) return null;
  const stage = i["stage"] as string;
  return {
    id: i["id"] as string,
    name: i["name"] as string,
    stage: stages.includes(stage) ? stage : null,
    state: i["state"] as TimelineState,
    size: (i["size"] as string | undefined) ?? "",
    next: i["next"] as string,
    owner: i["owner"] as string,
    target: i["target"] as string,
    link: (i["link"] as string | undefined) ?? "",
  };
}

/** One file's timeline, or null when it cannot be read or is not a timeline at all. */
export function parseTimeline(text: string): Timeline | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const stages = v["stages"];
  const items = v["items"];
  const ok =
    [v["project"], v["title"], v["updatedAt"]].every(str) &&
    optStr(v["note"]) &&
    Array.isArray(stages) &&
    stages.every(str) &&
    Array.isArray(items);
  if (!ok) return null;
  const read = items.map((i) => itemOf(i, stages));
  const kept = read.filter((i): i is TimelineItem => i !== null);
  return {
    project: v["project"] as string,
    title: v["title"] as string,
    updatedAt: v["updatedAt"] as string,
    stages,
    note: (v["note"] as string | undefined) ?? "",
    items: kept,
    dropped: read.length - kept.length,
  };
}

/** Every readable timeline in DORI_HOME/timelines, by file name; a missing folder or a broken file is left out. */
export function readTimelines(home: string): Timeline[] {
  const dir = join(home, "timelines");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => {
      try {
        return parseTimeline(readFileSync(join(dir, n), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((t): t is Timeline => t !== null);
}

/** How many items are each owner's turn, in the order owners first appear. */
export function ownerCounts(t: Timeline): [string, number][] {
  const counts = new Map<string, number>();
  for (const i of t.items) counts.set(i.owner, (counts.get(i.owner) ?? 0) + 1);
  return [...counts];
}
