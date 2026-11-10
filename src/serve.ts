import type { Server } from "bun";
import { type DashboardState, dashboardState } from "./serve-state.ts";
import type { Store } from "./store.ts";

const REFRESH_SECONDS = 30;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const time = (at: number): string => new Date(at).toISOString().replace("T", " ").slice(0, 19);

// Only http(s) evidence becomes a link, so a stored `javascript:` value can never run in the operator's browser.
const link = (url: string): string => (/^https?:\/\//.test(url) ? `<a href="${esc(url)}">${esc(url)}</a>` : esc(url));

const table = (head: string[], rows: string[][]): string =>
  rows.length === 0
    ? `<p class="none">none</p>`
    : `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</table>`;

const stopText = (s: { at: number; reason: string } | null): string =>
  s ? `<b class="stopped">STOPPED</b> ${time(s.at)} ${esc(s.reason)}` : `<span class="ok">running</span>`;

function renderHtml(s: DashboardState): string {
  const lanes = table(
    ["key", "status", "pane", "last activity", "log", "final"],
    s.lanes.map((l) => [
      esc(l.key),
      `<span class="st-${l.status}">${l.status}</span>`,
      esc(l.pane),
      time(l.lastActivityAt),
      l.log.map((e) => `${time(e.at)} ${esc(e.kind)}: ${esc(e.text)}`).join("<br>"),
      l.final ? `${esc(l.final.text)}<br>${l.final.evidence.map(link).join("<br>")}` : "",
    ]),
  );
  const backlog = table(
    ["id", "title", "priority", "status", "decision"],
    s.backlog.map((i) => [esc(i.id), esc(i.title), String(i.priority), i.status, esc(i.decision ?? "")]),
  );
  const roles = table(
    ["role", "pane"],
    s.roles.map((r) => [r.role, esc(r.pane)]),
  );
  const inboxes = table(
    ["pane", "owner", "queued", "typed", "held"],
    s.inboxes.map((i) => [esc(i.pane), esc(i.owner ?? "-"), String(i.queued), String(i.typed), String(i.held)]),
  );
  const receipts = table(
    ["PR", "sha", "verdict", "at"],
    s.receipts.map((r) => [esc(r.pr), esc(r.sha.slice(0, 12)), r.verdict, time(r.at)]),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>dori</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:12px;color:#222;background:#fafafa}
h1{font-size:18px}h2{font-size:15px;margin-top:20px}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#eee}.none{color:#888}.stopped{color:#b00}.ok{color:#070}
.st-working{color:#05a}.st-waiting{color:#a60}.st-ready{color:#070}.st-done{color:#888}.st-lost{color:#b00}
</style></head><body>
<h1>dori</h1>
<p>${esc(s.home)} &middot; ${time(s.generatedAt)} UTC &middot; refreshes every ${REFRESH_SECONDS}s &middot; <a href="/api/state">/api/state</a></p>
<h2>Kill switches</h2><p>duty: ${stopText(s.stops.duty)}<br>loop: ${stopText(s.stops.loop)}</p>
<h2>Lanes</h2>${lanes}
<h2>Backlog</h2>${backlog}
<h2>Roles</h2>${roles}
<h2>Inboxes</h2>${inboxes}
<h2>Review receipts</h2>${receipts}
</body></html>
`;
}

/** Serves the read-only dashboard: `/` as HTML, `/api/state` as JSON. Every other path is 404, every non-GET 405. */
export function serveDashboard(
  store: Store,
  opts: { host: string; port: number; now: () => number },
): Server<undefined> {
  return Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch(req) {
      if (req.method !== "GET" && req.method !== "HEAD")
        return new Response("read-only\n", { status: 405, headers: { allow: "GET, HEAD" } });
      const { pathname } = new URL(req.url);
      if (pathname === "/api/state") return Response.json(dashboardState(store, opts.now()));
      if (pathname === "/")
        return new Response(renderHtml(dashboardState(store, opts.now())), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response("not found\n", { status: 404 });
    },
  });
}
