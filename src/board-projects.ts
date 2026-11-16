import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Refusal } from "./refusal.ts";
import { loadLeads } from "./standing.ts";

/**
 * Which project a piece of work belongs to, learned from the work itself rather than a fixed list. A standing lead
 * (leads.json) or a board.json `projects` entry is a seed; any other lane or item is placed by the repo directory its
 * cwd sits in, else the repo of a PR it names, else a key prefix other work taught (`drht-` lanes ran in drawhatha, so
 * `drht-x` is drawhatha too). What none of these place is 기타.
 */
export type Subject = { key: string; cwd: string; repos: string[] };
export type Link = { label: string; url: string };
export type Seed = {
  name: string;
  /** Key prefixes (leads.json keyPrefixes): `fmv-` also places a key or channel named `fmv`. */
  prefixes: string[];
  /** board.json words: placed when the key or cwd contains one. */
  words: string[];
  repos: string[];
  dirs: string[];
  bots: string[];
  /** board.json object form: a one-line description and links the project page shows. */
  note: string | null;
  links: Link[];
};

export const OTHER = "기타";
/** Directories that hold repos rather than being one: workspace/personal/<repo>, workspace/oss/<repo>. */
const HOLDERS = new Set(["personal", "oss"]);

/** A repo or directory name as a project name: `vibeguard.run-worktrees` → vibeguard. */
export const projectName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/-worktrees$/, "")
    .split(".")[0]!;

/** The project name of the repo directory a cwd sits in (the first directory below `workspace`), or null. */
export function repoOfCwd(cwd: string): string | null {
  const parts = cwd.split("/").filter(Boolean);
  let i = parts.lastIndexOf("workspace") + 1;
  if (i === 0) return null;
  while (parts[i] && HOLDERS.has(parts[i]!)) i++;
  return parts[i] ? projectName(parts[i]!) || null : null;
}

const tokenOf = (key: string): string | null => {
  const t = key.toLowerCase().split("-")[0] ?? "";
  return /^[a-z][a-z0-9]+$/.test(t) ? t : null;
};
const bare = (prefix: string): string => prefix.toLowerCase().replace(/-+$/, "");

/** The standing leads and board.json `projects`; an unreadable file adds no seeds (the board still shows the work). */
export function projectSeeds(home: string): Seed[] {
  let leads: ReturnType<typeof loadLeads> = [];
  try {
    leads = loadLeads(home);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
  }
  const seeds: Seed[] = leads.map((l) => ({
    name: l.domain,
    prefixes: l.keyPrefixes.map(bare).filter((p) => p !== ""),
    words: [],
    repos: l.repos.map((r) => r.toLowerCase()),
    dirs: l.cwds.map((c) => repoOfCwd(c) ?? projectName(basename(c))),
    bots: [...l.bots],
    note: null,
    links: [],
  }));
  const path = join(home, "board.json");
  try {
    const p = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["projects"]
      : undefined;
    for (const [name, v] of p && typeof p === "object" && !Array.isArray(p) ? Object.entries(p) : []) {
      const seed = boardSeed(name, v);
      if (seed) seeds.push(seed);
    }
  } catch {
    // a board.json that is not JSON is reported by the board's own config loader; it adds no projects here
  }
  return seeds;
}

const strings = (v: unknown): string[] | null =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every((w) => typeof w === "string" && w.trim() !== "")
      ? (v as string[])
      : null;
const linksOf = (v: unknown): Link[] | null => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const ok = (l: unknown): l is Link =>
    typeof l === "object" &&
    l !== null &&
    typeof (l as Link).label === "string" &&
    (l as Link).label.trim() !== "" &&
    typeof (l as Link).url === "string" &&
    /^https?:\/\/\S+$/.test((l as Link).url);
  return v.every(ok) ? v.map((l) => ({ label: l.label, url: l.url })) : null;
};

/**
 * One board.json `projects` entry: `["word", …]`, or `{ words, repos: ["owner/repo"], dirs, note, links: [{ label, url }] }`
 * with every field optional. An entry of another shape, or with a field of the wrong type, is ignored (null).
 */
export function boardSeed(name: string, v: unknown): Seed | null {
  if (name.trim() === "") return null;
  const seed = { name, prefixes: [], words: [], repos: [], dirs: [], bots: [], note: null, links: [] };
  if (Array.isArray(v)) {
    const words = strings(v);
    return words ? { ...seed, words } : null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const words = strings(o["words"]);
  const repos = strings(o["repos"]);
  const dirs = strings(o["dirs"]);
  const links = linksOf(o["links"]);
  const note = o["note"] === undefined ? null : typeof o["note"] === "string" ? o["note"].trim() || null : undefined;
  if (!words || !repos || !dirs || !links || note === undefined) return null;
  if (!repos.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r))) return null;
  return {
    ...seed,
    words,
    repos: repos.map((r) => r.toLowerCase()),
    dirs: dirs.map(projectName),
    note,
    links,
  };
}

/** Places every subject; `all` is the work the prefixes are learned from (every lane and backlog item, done included). */
export function projectResolver(seeds: Seed[], all: Subject[]): (s: Subject) => string {
  const seedOf = (s: Subject): string | undefined => {
    const repo = repoOfCwd(s.cwd);
    const hay = `${s.key} ${s.cwd}`.toLowerCase();
    return seeds.find(
      (p) =>
        p.prefixes.some((w) => s.key.toLowerCase().startsWith(w)) ||
        (repo !== null && (repo === p.name || p.dirs.includes(repo))) ||
        s.repos.some((r) => p.repos.includes(r.toLowerCase())) ||
        p.words.some((w) => hay.includes(w.toLowerCase())),
    )?.name;
  };
  const direct = (s: Subject): string | null => {
    const fromPr = s.repos.map((r) => projectName(r.split("/")[1] ?? "")).find((n) => n !== "");
    return seedOf(s) ?? repoOfCwd(s.cwd) ?? fromPr ?? null;
  };
  const known = new Set(seeds.map((p) => p.name));
  const votes = new Map<string, Map<string, number>>();
  for (const s of all) {
    const d = direct(s);
    const t = tokenOf(s.key);
    if (!d) continue;
    known.add(d);
    if (!t) continue;
    const v = votes.get(t) ?? new Map<string, number>();
    v.set(d, (v.get(d) ?? 0) + 1);
    votes.set(t, v);
  }
  const alias = new Map<string, string>();
  for (const [t, v] of votes) alias.set(t, [...v].sort((a, b) => b[1] - a[1])[0]![0]);
  return (s) => {
    const d = direct(s);
    if (d) return d;
    const t = tokenOf(s.key);
    if (!t) return OTHER;
    return alias.get(t) ?? (known.has(t) ? t : OTHER);
  };
}
