import { join } from "node:path";

const STATIC: Record<string, [string, string]> = {
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/board.js": ["board.js", "text/javascript; charset=utf-8"],
};
const ASSETS = join(import.meta.dir, "..", "assets", "board");

/** The board's icons and its script, or null for any other path. */
export function staticResponse(path: string): Response | null {
  const asset = STATIC[path];
  return asset
    ? new Response(Bun.file(join(ASSETS, asset[0])), {
        headers: { "content-type": asset[1], "x-content-type-options": "nosniff" },
      })
    : null;
}
