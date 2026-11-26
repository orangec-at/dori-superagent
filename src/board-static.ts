import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATIC: Record<string, [string, string]> = {
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/board.js": ["board.js", "text/javascript; charset=utf-8"],
};
const ASSETS = join(import.meta.dir, "..", "assets", "board");
/** The 시트 editor's bundle (bun run build:sheets): sheets.js, sheets.css and the chunks sheets.js imports on demand. */
const SHEETS = join(ASSETS, "sheets");
const SHEET_FILE = /^\/sheets\/([\w-]+)\.(js|css)$/;
const TYPES: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
/** The bundle is megabytes and tailscale serve does not compress: each file is gzipped once and kept. */
const gzipped = new Map<string, Uint8Array<ArrayBuffer>>();
let version: string | null | undefined;

/** A hash of sheets.js and sheets.css the page puts in their URLs, so a new build is fetched; null when not built. */
export function sheetsAssets(): string | null {
  if (version === undefined) {
    try {
      const both = Buffer.concat([readFileSync(join(SHEETS, "sheets.js")), readFileSync(join(SHEETS, "sheets.css"))]);
      version = Bun.hash(both).toString(36);
    } catch {
      version = null;
    }
  }
  return version;
}

function sheetFile(name: string, type: string, req: Request): Response | null {
  let body = gzipped.get(name);
  if (!body) {
    try {
      body = Bun.gzipSync(readFileSync(join(SHEETS, name)));
    } catch {
      return null;
    }
    gzipped.set(name, body);
  }
  // The entry's URL carries the build's hash and every chunk's name its own, so a file never changes under its URL.
  const headers = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "max-age=31536000, immutable",
  };
  return (req.headers.get("accept-encoding") ?? "").includes("gzip")
    ? new Response(body, { headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" } })
    : new Response(Bun.file(join(SHEETS, name)), { headers: { ...headers, vary: "accept-encoding" } });
}

/** The board's icons, its script and the 시트 editor's bundle, or null for any other path. */
export function staticResponse(path: string, req: Request): Response | null {
  const sheet = SHEET_FILE.exec(path);
  if (sheet) return sheetFile(`${sheet[1]}.${sheet[2]}`, TYPES[sheet[2]!]!, req);
  const asset = STATIC[path];
  return asset
    ? new Response(Bun.file(join(ASSETS, asset[0])), {
        headers: { "content-type": asset[1], "x-content-type-options": "nosniff" },
      })
    : null;
}
