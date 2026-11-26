/**
 * The 시트 tab's phone touch, checked the way a phone delivers it: headless Chrome emulates a 412x915 touch screen and
 * gets real touches over CDP (Input.dispatchTouchEvent), so the browser itself makes the pointer events and the
 * compatibility mouse events that follow a tap, as Chrome on Android does. Built bundle in assets/board/sheets.
 *
 *   bun run build:sheets && bun test/sheets-touch-cdp.ts [out-dir]
 *   UA='<an Android browser>' NO_ONTOUCH=1 bun test/sheets-touch-cdp.ts [out-dir]
 *
 * The second is a phone whose document has no ontouchend (Chrome's --touch-events=disabled), under which Univer's
 * engine reads mouse events. W, DPR (412, 2) set the screen, JITTER=n moves each tap n px as a finger does.
 * Prints one `PASS`/`FAIL` line per gesture, the page's exceptions and clientlog lines, saves a screenshot of each,
 * exits 1 on a FAIL. Needs google-chrome (or CHROME=<path>). Not in `bun test`: it starts a browser, ~15 seconds.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHEETS_STYLE, sheetPane } from "../src/board-sheets-html.ts";

const OUT = process.argv[2] ?? join(tmpdir(), "sheets-touch-cdp");
const ASSETS = join(import.meta.dir, "..", "assets", "board", "sheets");
const COLS = 6;
const ROWS = 60;
const name = (r: number, c: number): string => `${"ABCDEF"[c]}${r + 1}`;
const cellData: Record<number, Record<number, { v: string }>> = {};
for (let r = 0; r < ROWS; r++) {
  cellData[r] = {};
  for (let c = 0; c < COLS; c++) (cellData[r] as Record<number, { v: string }>)[c] = { v: name(r, c) };
}
const snapshot = {
  id: "w",
  name: "touch",
  sheetOrder: ["s1"],
  sheets: { s1: { id: "s1", name: "S1", rowCount: 100, columnCount: 20, cellData } },
};
let onSave: (snapshot: unknown) => void = () => {};
const logs: string[] = [];
const file = { rev: 1, savedAt: new Date().toISOString(), snapshot };
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--bg:#fff;--line:#ccc;--text:#000;--muted:#666;--red:#c00}body{margin:0}${SHEETS_STYLE}</style>
<link rel="stylesheet" href="/sheets/sheets.css"><script type="module" src="/sheets/sheets.js"></script></head>
<body>${sheetPane({ list: [], open: { id: "touch-1", file }, missing: false }, "tok")}</body></html>`;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/sheets/")) return new Response(Bun.file(join(ASSETS, url.pathname.slice(8))));
    if (url.pathname === "/sheets" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      if (form.get("action") === "clientlog") {
        logs.push(`${form.get("kind")} ${form.get("message")}`);
        return new Response(null, { status: 204 });
      }
      onSave(JSON.parse(form.get("snapshot") ?? "{}"));
      return Response.json({ rev: ++file.rev });
    }
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

const profile = mkdtempSync(join(tmpdir(), "sheets-touch-chrome-"));
const chrome = Bun.spawn(
  [
    process.env["CHROME"] ?? "google-chrome",
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(process.env["NO_ONTOUCH"] ? ["--touch-events=disabled"] : []),
    "about:blank",
  ],
  { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
);
const wsUrl = await (async () => {
  let text = "";
  for await (const chunk of chrome.stderr) {
    text += new TextDecoder().decode(chunk);
    const m = /DevTools listening on (ws:\S+)/.exec(text);
    if (m) return m[1] as string;
  }
  throw new Error(`chrome gave no DevTools url: ${text}`);
})();

const ws = new WebSocket(wsUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
let seq = 0;
const waiting = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>();
const exceptions: string[] = [];
let session = "";
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w?.bad(new Error(JSON.stringify(msg.error)));
    else w?.ok(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    exceptions.push(d.exception?.description ?? d.text);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    exceptions.push(`console.error ${msg.params.args.map((a: { value?: unknown }) => a.value).join(" ")}`);
  }
});
// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON.
const cdp = (method: string, params: object = {}, root = false): Promise<any> => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(root ? {} : { sessionId: session }) }));
  return new Promise((ok, bad) => waiting.set(id, { ok, bad }));
};
const evaluate = async <T>(expression: string): Promise<T> =>
  (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value as T;
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

const { targetId } = await cdp("Target.createTarget", { url: "about:blank" }, true);
session = (await cdp("Target.attachToTarget", { targetId, flatten: true }, true)).sessionId;
await cdp("Runtime.enable");
await cdp("Page.enable");
const W = Number(process.env["W"] ?? 412);
const DPR = Number(process.env["DPR"] ?? 2);
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: 915, deviceScaleFactor: DPR, mobile: true });
if (process.env["UA"])
  await cdp("Emulation.setUserAgentOverride", { userAgent: process.env["UA"], platform: "Linux armv8l" });
if (!process.env["NO_ONTOUCH"]) await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await cdp("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
const ready = await evaluate<boolean>(`new Promise((ok) => {
  const t = setTimeout(() => ok(false), 20000);
  const check = () => { const h = document.getElementById("sheet"); if (h && "ready" in h.dataset) { clearTimeout(t); ok(true); } };
  addEventListener("load", () => { check(); new MutationObserver(check).observe(document.body, { attributes: true, subtree: true }); });
  if (document.readyState === "complete") { check(); new MutationObserver(check).observe(document.body, { attributes: true, subtree: true }); }
})`);
if (!ready) throw new Error("the sheet never reached Univer's Steady stage");
await sleep(500);

/** Univer's grid at zoom 1.1 for this width: the row header, the column header, a column and a row. */
const grid = await evaluate<{ x: number; y: number }>(
  `(() => { const [r] = [...document.querySelectorAll("#sheet canvas")].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height); return { x: r.left, y: r.top }; })()`,
);
const Z = 1.1;
const at = (r: number, c: number): { x: number; y: number } => ({
  x: Math.round(grid.x + 46 * Z + (c + 0.5) * 88 * Z),
  y: Math.round(grid.y + 20 * Z + (r + 0.5) * 24 * Z),
});

let touchId = 0;
type P = { x: number; y: number };
const JITTER = Number(process.env["JITTER"] ?? 0);
const touch = async (path: P[], holdMs = 60, stepMs = 16): Promise<void> => {
  const id = ++touchId;
  const [first] = path as [P];
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...first, id }] });
  for (let i = 1; i <= JITTER; i++) {
    await sleep(Math.min(20, holdMs / (JITTER + 1)));
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: first.x + i, y: first.y + i, id }] });
  }
  await sleep(holdMs);
  for (const p of path.slice(1)) {
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id }] });
    await sleep(stepMs);
  }
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const line = (a: P, b: P, n: number): P[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
const inputValue = (): Promise<string> => evaluate(`document.getElementById("shinput").value`);
const focused = (): Promise<string> => evaluate(`document.activeElement?.id ?? ""`);

mkdirSync(OUT, { recursive: true });
const shot = async (label: string): Promise<void> => {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(OUT, `${label}.png`), Buffer.from(data, "base64"));
};
const results: string[] = [];
const check = (label: string, ok: boolean, detail: string): void => {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
};

// 1. A tap selects the cell: the input line shows its value.
await touch([at(1, 1)]);
await sleep(400);
const tapped = await inputValue();
await shot("1-tap-B2");
check("tap", tapped === "B2", `input line "${tapped}" (want B2)`);

// 2. A double tap edits the cell in the input line.
await touch([at(3, 2)]);
await sleep(120);
await touch([at(3, 2)]);
// Past the input line's REFOCUS_MS, so a focus Univer takes later than that would show.
await sleep(1500);
const dValue = await inputValue();
const dFocus = await focused();
await shot("2-doubletap-C4");
check(
  "double tap",
  dValue === "C4" && dFocus === "shinput",
  `input line "${dValue}", focus #${dFocus} (want C4, #shinput)`,
);
await evaluate(`document.getElementById("shinput").blur()`);
await sleep(200);

// 3. Held still, then dragged: a range. Delete then clears exactly that range, which the next save shows.
await touch([at(1, 0), ...line(at(1, 0), at(3, 1), 8)], 700, 40);
await sleep(400);
await shot("3-hold-drag-A2-B4");
const nextSave = new Promise((ok) => {
  onSave = ok;
  setTimeout(() => ok(null), 5000);
});
await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
const saved = (await nextSave) as { sheets?: { s1?: { cellData?: Record<number, Record<number, { v?: unknown }>> } } };
const cells = saved?.sheets?.s1?.cellData ?? {};
const cleared: string[] = [];
for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) if (cells[r]?.[c]?.v === undefined) cleared.push(name(r, c));
await shot("3b-after-delete");
check(
  "hold and drag",
  cleared.join(",") === "A2,B2,A3,B3,A4,B4",
  `Delete cleared [${cleared.join(",")}] (want A2..B4)`,
);

// 4. One finger dragged up scrolls: the same spot then taps a cell further down.
await touch(line(at(12, 2), at(2, 2), 10));
await sleep(600);
await touch([at(5, 2)]);
await sleep(400);
const scrolled = await inputValue();
await shot("4-drag-scroll-then-tap");
const row = Number(scrolled.slice(1));
check(
  "drag scroll",
  scrolled.startsWith("C") && row > 8,
  `tap after scrolling selects "${scrolled}" (want a C row below 8)`,
);

for (const r of results) console.log(r);
for (const e of exceptions) console.log(`EXCEPTION ${e.split("\n")[0]}`);
for (const l of logs) console.log(`CLIENTLOG ${l}`);
console.log(`SHOTS ${OUT}`);
ws.close();
chrome.kill();
await chrome.exited;
rmSync(profile, { recursive: true, force: true });
server.stop(true);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
