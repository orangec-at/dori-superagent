import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DORI_HOME/sheets/<id>.json, one per sheet of the 시트 tab: `snapshot` is the Univer workbook snapshot (IWorkbookData)
 * the editor saved, `rev` counts the saves. A save names the rev its page opened and is refused while the file holds
 * another one, so a second device or tab never overwrites a save it has not seen (there is no live co-editing).
 */
export type SheetFile = { rev: number; savedAt: string; snapshot: Record<string, unknown>; sid?: string };
export type SheetMeta = { id: string; name: string; rev: number; savedAt: string };
/** The 시트 tab's data: the sheets newest first, and the one `?s=` opened (null: none asked, `missing`: not found). */
export type SheetsView = { list: SheetMeta[]; open: { id: string; file: SheetFile } | null; missing: boolean };

type Out = {
  reject: (code: string, why: string, status: number) => Response;
  log: (line: string) => void;
  headers: Record<string, string>;
};

/** A form-encoded body may carry a snapshot of SNAPSHOT_MAX characters escaped (up to 9 characters for one). */
export const SHEET_BODY_MAX = 8 * 1024 * 1024;
const SNAPSHOT_MAX = 2 * 1024 * 1024;
const NAME_MAX = 80;
/** Ids are made here (date and random hex), so an id never holds a dot or a slash. */
const ID = /^[a-z0-9-]{1,40}$/;
/** A save's own id, made by the editor for each request it sends. */
const SID = /^[0-9a-f]{16}$/;
/** The editor names at most this many of its saves whose answer it never got. */
const LOST_MAX = 8;
const CLIENT_KINDS = new Set(["network", "keepalive", "http", "retry", "error", "touch", "open"]);
const CLIENT_MAX = 2048;

const dir = (home: string): string => join(home, "sheets");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fileOf(v: unknown): SheetFile | null {
  if (!isObject(v)) return null;
  const { rev, savedAt, snapshot, sid } = v;
  return Number.isSafeInteger(rev) && (rev as number) >= 0 && typeof savedAt === "string" && isObject(snapshot)
    ? { rev: rev as number, savedAt, snapshot, ...(typeof sid === "string" ? { sid } : {}) }
    : null;
}

export function readSheet(home: string, id: string): SheetFile | null {
  if (!ID.test(id)) return null;
  try {
    return fileOf(JSON.parse(readFileSync(join(dir(home), `${id}.json`), "utf8")));
  } catch {
    return null;
  }
}

const nameOf = (f: SheetFile): string =>
  typeof f.snapshot["name"] === "string" && f.snapshot["name"].trim() !== "" ? f.snapshot["name"] : "이름 없는 시트";

/** Every readable sheet, the last saved first; a file of another shape is left out. */
export function listSheets(home: string): SheetMeta[] {
  let names: string[];
  try {
    names = readdirSync(dir(home));
  } catch {
    return [];
  }
  return names
    .flatMap((n) => {
      const id = n.endsWith(".json") ? n.slice(0, -5) : "";
      const f = readSheet(home, id);
      return f ? [{ id, name: nameOf(f), rev: f.rev, savedAt: f.savedAt }] : [];
    })
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

export function sheetsView(home: string, s: string | null): SheetsView {
  const file = s ? readSheet(home, s) : null;
  return { list: listSheets(home), open: s && file ? { id: s, file } : null, missing: Boolean(s) && !file };
}

function writeSheet(home: string, id: string, f: SheetFile): void {
  mkdirSync(dir(home), { recursive: true });
  const path = join(dir(home), `${id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(f));
  renameSync(`${path}.tmp`, path);
}

const blank = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  locale: "koKR",
  styles: {},
  sheetOrder: ["sheet1"],
  sheets: { sheet1: { id: "sheet1", name: "시트1", rowCount: 200, columnCount: 26, cellData: {} } },
});

/**
 * POST /sheets, reached only after the board's writer, origin and CSRF checks passed (the same as /decide and
 * /coupas). `new` makes an empty sheet and opens it; `save` writes the snapshot when `rev` is the file's rev and answers
 * the new rev (JSON for the editor, a redirect for a plain form), else 409 and nothing is written.
 */
export function sheetsPost(home: string, now: number, form: URLSearchParams, o: Out, json: boolean): Response {
  const action = form.get("action") ?? "";
  const savedAt = new Date(now).toISOString();
  if (action === "new") {
    const name = (form.get("name") ?? "").trim() || "새 시트";
    if (name.length > NAME_MAX) return o.reject("length", `name longer than ${NAME_MAX} characters`, 413);
    const id = `${savedAt.slice(0, 10)}-${randomBytes(4).toString("hex")}`;
    writeSheet(home, id, { rev: 1, savedAt, snapshot: blank(id, name) });
    o.log(`BOARD_SHEET new ${id}`);
    return new Response(null, { status: 303, headers: { location: `/?tab=sheets&s=${id}`, ...o.headers } });
  }
  if (action === "clientlog") return clientLog(home, form, o);
  if (action !== "save") return o.reject("action", "unknown sheets action", 400);
  const id = form.get("id") ?? "";
  const was = readSheet(home, id);
  if (!was) return o.reject("sheet", "unknown sheet", 404);
  // A save whose answer the editor lost may still have been written: when the file's last save is one the same page
  // names as lost, nothing from elsewhere came in between, so this save goes on from it instead of being refused.
  const lost = (form.get("lost") ?? "").split(",").slice(0, LOST_MAX);
  const ours = was.sid !== undefined && lost.includes(was.sid);
  if (form.get("rev") !== String(was.rev) && !ours)
    return o.reject("rev", "conflict: this sheet was saved elsewhere since this page opened, reload it", 409);
  const sid = form.get("sid") ?? "";
  const text = form.get("snapshot") ?? "";
  if (text.length > SNAPSHOT_MAX) return o.reject("size", "sheet too large", 413);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(text);
  } catch {
    snapshot = null;
  }
  if (!isObject(snapshot)) return o.reject("snapshot", "the snapshot is not a workbook", 400);
  const rev = was.rev + 1;
  writeSheet(home, id, { rev, savedAt, snapshot, ...(SID.test(sid) ? { sid } : {}) });
  o.log(
    `BOARD_SHEET save ${id} rev=${rev} len=${text.length}${ours && form.get("rev") !== String(was.rev) ? " resumed" : ""}`,
  );
  return json
    ? Response.json({ rev, savedAt }, { headers: o.headers })
    : new Response(null, { status: 303, headers: { location: `/?tab=sheets&s=${id}`, ...o.headers } });
}

const intIn = (v: string | null, max: number): number | null =>
  v !== null && /^\d{1,5}$/.test(v) && Number(v) <= max ? Number(v) : null;

/**
 * action=clientlog: the editor reports why a save failed, an error on its page (`error`), a touch fix it applied or
 * how a finger lift on the grid went (`touch`) or its opening (`open`: bundle version, screen and touch support, the start of the user agent), one line in the board's log and nothing written. It carries no cell text, only the failure (kind, HTTP
 * status, the error's message) and the screen (width, hidden or not).
 */
function clientLog(home: string, form: URLSearchParams, o: Out): Response {
  if (form.toString().length > CLIENT_MAX) return o.reject("size", "client log too large", 413);
  const id = form.get("id") ?? "";
  const kind = form.get("kind") ?? "";
  const status = intIn(form.get("status"), 999);
  const vw = intIn(form.get("vw"), 99_999);
  const hidden = form.get("hidden");
  if (!ID.test(id) || !CLIENT_KINDS.has(kind) || status === null || vw === null || (hidden !== "1" && hidden !== "0"))
    return o.reject("clientlog", "bad client log", 400);
  if (!readSheet(home, id)) return o.reject("sheet", "unknown sheet", 404);
  // Quoted, so no message can pass for the fields after it; line breaks and format (bidi) characters become spaces.
  const message = JSON.stringify(
    (form.get("message") ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").slice(0, 200),
  );
  o.log(`BOARD_SHEET_CLIENT ${id} ${kind} ${status} ${message} vw=${vw} hidden=${hidden === "1"}`);
  return new Response(null, { status: 204, headers: o.headers });
}
