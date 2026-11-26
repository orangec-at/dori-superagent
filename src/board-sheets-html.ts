import type { SheetsView } from "./board-sheets.ts";
import { sheetsAssets } from "./board-static.ts";
import { ago, esc, form } from "./board-thread-html.ts";

/**
 * The open sheet fills the pane below its header (Univer needs a box with a height) and the page does not scroll under
 * it. The board's own button look is taken back inside the sheet, at a weight Univer's classes still win over. The
 * saving state is the column's last line, so it stays at the bottom of the screen at any width (a phone, a Fold).
 */
export const SHEETS_STYLE = `.shn{display:flex;gap:8px;margin:4px 6px 10px}.shn input{flex:1;min-width:0;min-height:42px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:inherit}
.shp{display:flex;flex-direction:column;height:100dvh}.shp .rec-h{position:static}.shp #sheet{flex:1;min-height:0}body:has(.shp){overflow:hidden}
button:where(#sheet *){font:revert;min-height:revert;min-width:revert;padding:revert;border-radius:revert;border:revert;background:revert;color:revert;cursor:revert}#shs.bad{color:var(--red)}
.shp #shs{flex:none;margin:0;min-height:30px;padding:5px 12px calc(5px + env(safe-area-inset-bottom));border-top:1px solid var(--line);font-size:14px;text-align:center}@media (max-width:1023px){#shsave{min-height:44px;min-width:64px}}`;

const KST = 9 * 3_600_000;
const kstOf = (iso: string): string => new Date(Date.parse(iso) + KST).toISOString().slice(5, 16).replace("T", " ");
const hrefOf = (id: string): string => `/?tab=sheets&s=${encodeURIComponent(id)}`;

export function sheetsTab(v: SheetsView | null, now: number, token: string | null): string {
  const make = form(
    "/sheets",
    token,
    `<input type="hidden" name="action" value="new"><div class="shn"><input name="name" maxlength="80" placeholder="새 시트 이름" aria-label="새 시트 이름"><button class="primary">새 시트</button></div>`,
  );
  const rows = (v?.list ?? [])
    .map(
      (s) =>
        `<a class="row${s.id === v?.open?.id ? " on" : ""}" href="${esc(hrefOf(s.id))}"><span class="rb"><span class="rt"><b>${esc(s.name)}</b>` +
        `<span class="ago">${ago(now, Date.parse(s.savedAt))}</span></span><span class="rs">고친 시각 ${esc(kstOf(s.savedAt))} KST · ${s.rev}판</span></span></a>`,
    )
    .join("");
  return make + (rows || `<p class="note">아직 시트가 없어요. 이름을 쓰고 [새 시트]를 눌러요.</p>`);
}

/**
 * The open sheet: its header (saving state, a save button) over the box Univer fills. The snapshot rides in a JSON
 * script block, `<` escaped so no text in a cell can close it; sheets.js reads it, the token and the rev it opened.
 */
export function sheetPane(v: SheetsView | null, token: string | null): string {
  if (!v?.open)
    return `<p class="note">${v?.missing ? "찾을 수 없는 시트예요." : "시트를 고르거나 새로 만들어요."}</p>`;
  const { id, file } = v.open;
  const name = typeof file.snapshot["name"] === "string" ? file.snapshot["name"] : "";
  const data = JSON.stringify(file.snapshot).replace(/</g, "\\u003c");
  return (
    `<div class="shp" data-sheet="${esc(id)}" data-rev="${file.rev}" data-csrf="${esc(token ?? "")}"><header class="rec-h">` +
    `<a class="back" href="/?tab=sheets" aria-label="목록으로">←</a><div class="title"><b>${esc(name)}</b></div>` +
    `${token ? `<button id="shsave" type="button">저장</button>` : ""}</header><div id="sheet"></div>` +
    `<p class="meta" id="shs" role="status">${token ? "" : "읽기 전용이에요."}</p>` +
    `<script type="application/json" id="sheet-data">${data}</script></div>`
  );
}

/** The editor's script and style, only on a page with an open sheet; the rest of the board never loads them. */
export const sheetHead = (v: SheetsView | null | undefined): string => {
  const a = v?.open ? sheetsAssets() : null;
  return a
    ? `<link rel="stylesheet" href="/sheets/sheets.css?v=${a}"><script type="module" src="/sheets/sheets.js?v=${a}"></script>`
    : "";
};
