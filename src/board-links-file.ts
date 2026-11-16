import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkSnapshot } from "./board-links.ts";

/** DORI_HOME/board-links.json: written by the collection (board-links.ts), only read by the board. */

/** What the board read: the map, null when never collected, "broken" when the file is there but not a map. */
export type LinksRead = LinkSnapshot | "broken" | null;
const KINDS: readonly string[] = ["lead", "duty", "standing", "lane", "bot", "relay"];
const linksPath = (home: string): string => join(home, "board-links.json");

export function saveLinks(home: string, s: LinkSnapshot): string {
  const path = linksPath(home);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isChannel = (v: unknown): boolean => {
  const c = (v ?? {}) as Record<string, unknown>;
  return str(c["name"]) && str(c["with"]) && (c["dir"] === "both" || c["dir"] === "in" || c["dir"] === "out");
};
const isActor = (v: unknown): boolean => {
  const a = (v ?? {}) as Record<string, unknown>;
  return (
    [a["id"], a["label"], a["computer"], a["cli"], a["source"]].every(str) &&
    KINDS.includes(a["kind"] as string) &&
    [a["provider"], a["model"], a["via"]].every(strOrNull) &&
    Array.isArray(a["from"]) &&
    a["from"].every(str) &&
    Array.isArray(a["channels"]) &&
    a["channels"].every(isChannel)
  );
};

/** The last collected map; null when it was never collected, "broken" when the file is not a map this board can draw. */
export function readLinks(home: string): LinksRead {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(readFileSync(linksPath(home), "utf8")) as Record<string, unknown>;
  } catch (e) {
    return (e as { code?: unknown }).code === "ENOENT" ? null : "broken";
  }
  const ok =
    typeof v === "object" &&
    v !== null &&
    typeof v["generatedAt"] === "number" &&
    Array.isArray(v["actors"]) &&
    v["actors"].every(isActor) &&
    Array.isArray(v["unknown"]) &&
    v["unknown"].every(str);
  return ok ? (v as unknown as LinkSnapshot) : "broken";
}
