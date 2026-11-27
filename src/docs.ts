import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";

/**
 * DORI_HOME/docs/<id>.md, one per document of the board's 문서 tab: a YAML front matter (`title`, `date` ISO, optional
 * `project` and one-line `summary`) over the markdown body. `dori doc add` writes them; the board only reads them.
 * A new version of an id moves the one before it to docs/.history/<id>/<time>.md.
 */
export type DocMeta = { id: string; title: string; date: string; project?: string; summary?: string };
export type Doc = DocMeta & { body: string };
/** The 문서 tab's data: the documents newest first (only project `p`'s when set), every project named, the one `d` opened. */
export type DocsView = { list: DocMeta[]; projects: string[]; p: string | null; open: Doc | null; missing: boolean };

/** `YYYY-MM-DD-<name>`, letters, digits and hyphens only: an id never holds a dot or a slash. */
const ID = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]{0,59}$/;
const TITLE_MAX = 200;
const KST = 9 * 3_600_000;

export const isDocId = (id: string): boolean => ID.test(id);
const dir = (home: string): string => join(home, "docs");

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const s: unknown = JSON.parse(v);
      if (typeof s === "string") return s;
    } catch {
      // not JSON: a YAML double-quoted string with other escapes is kept as written
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Splits a `---` front matter of flat `key: value` lines from the body; without one, the whole text is the body. */
export function parseDoc(text: string): { meta: Record<string, string>; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = unquote(kv[2]!.trim());
  }
  return { meta, body: text.slice(m[0].length) };
}

export function readDoc(home: string, id: string): Doc | null {
  if (!ID.test(id)) return null;
  let text: string;
  try {
    text = readFileSync(join(dir(home), `${id}.md`), "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseDoc(text);
  const { project, summary } = meta;
  return {
    id,
    title: meta["title"] || id,
    date: meta["date"] ?? "",
    ...(project ? { project } : {}),
    ...(summary ? { summary } : {}),
    body,
  };
}

const timeOf = (date: string): number => {
  const t = Date.parse(date);
  return Number.isNaN(t) ? 0 : t;
};

/** Every document, the newest date first (the id breaks a tie); a name that is not an id is left out. */
export function listDocs(home: string): DocMeta[] {
  let names: string[];
  try {
    names = readdirSync(dir(home));
  } catch {
    return [];
  }
  return names
    .flatMap((n) => {
      const doc = n.endsWith(".md") ? readDoc(home, n.slice(0, -3)) : null;
      if (!doc) return [];
      const { body: _, ...meta } = doc;
      return [meta];
    })
    .sort((a, b) => timeOf(b.date) - timeOf(a.date) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function docsView(home: string, p: string | null, d: string | null): DocsView {
  const open = d ? readDoc(home, d) : null;
  const list = listDocs(home);
  const projects = [...new Set(list.flatMap((m) => (m.project ? [m.project] : [])))].sort();
  return { list: p ? list.filter((m) => m.project === p) : list, projects, p, open, missing: Boolean(d) && !open };
}

const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();

/** The id a file gets without --id: today's date in KST and the file's name, or a random name for a name like 보고서.md. */
function idFor(name: string, now: number): string {
  const base = name.replace(/\.(md|markdown)$/i, "");
  if (ID.test(base)) return base;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${new Date(now + KST).toISOString().slice(0, 10)}-${slug || `doc-${randomBytes(3).toString("hex")}`}`;
}

/** docs/.history/<id>/<the old version's date>.md, with -2, -3... when that name is taken. */
function historyPath(home: string, id: string, date: string, at: string): string {
  const history = join(dir(home), ".history", id);
  mkdirSync(history, { recursive: true });
  const stamp = /^[\w-]+$/.test(date.replace(/[:.]/g, "-")) ? date.replace(/[:.]/g, "-") : at.replace(/[:.]/g, "-");
  let path = join(history, `${stamp}.md`);
  for (let n = 2; existsSync(path); n++) path = join(history, `${stamp}-${n}.md`);
  return path;
}

export type DocAdd = { title: string; name: string; project?: string; summary?: string; id?: string };

/** Writes the document (the source's own front matter dropped) and answers its id; an older version goes to .history. */
export function addDoc(home: string, source: string, o: DocAdd, now: number): string {
  const id = o.id ?? idFor(o.name, now);
  if (!ID.test(id)) throw new Refusal(`doc id must look like YYYY-MM-DD-name (letters, digits, hyphens): ${id}`);
  const title = oneLine(o.title);
  if (!title) throw new Refusal("--title must not be empty");
  if (title.length > TITLE_MAX) throw new Refusal(`--title longer than ${TITLE_MAX} characters`);
  const at = new Date(now).toISOString();
  const head = [
    ["title", title],
    ["date", at],
    ["project", oneLine(o.project ?? "")],
    ["summary", oneLine(o.summary ?? "")],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const body = parseDoc(source).body;
  mkdirSync(dir(home), { recursive: true });
  const path = join(dir(home), `${id}.md`);
  // The new version is written in full before the old one moves, so the link never answers "not found" in between.
  writeFileSync(`${path}.tmp`, `---\n${head.join("\n")}\n---\n${body}`);
  if (existsSync(path)) renameSync(path, historyPath(home, id, readDoc(home, id)?.date ?? "", at));
  renameSync(`${path}.tmp`, path);
  return id;
}

/**
 * The board link of a document: DORI_HOME/board.json `publicUrl` (the https origin the phone opens, e.g.
 * https://host.ts.net:8446) in front of `/?tab=docs&d=<id>`, or the path alone when it is not set.
 */
export function docUrl(home: string, id: string): string {
  let base = "";
  try {
    const raw = JSON.parse(readFileSync(join(home, "board.json"), "utf8")) as Record<string, unknown>;
    const v = raw["publicUrl"];
    if (typeof v === "string" && /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(v)) base = v.replace(/\/$/, "");
  } catch {
    // no board.json (or not JSON): the path alone
  }
  return `${base}/?tab=docs&d=${id}`;
}
