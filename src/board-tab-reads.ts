import { readCoupas } from "./board-coupas.ts";
import type { View } from "./board-list-html.ts";
import { sheetsView } from "./board-sheets.ts";
import { docsView } from "./docs.ts";

/** The DORI_HOME files a page load reads for the 쿠파스, 시트 and 문서 tabs, each only when its own tab is open. */
export const tabReads = (home: string, view: View) => ({
  coupas: view.tab === "coupas" ? readCoupas(home) : null,
  sheets: view.tab === "sheets" ? sheetsView(home, view.s ?? null) : null,
  docs: view.tab === "docs" ? docsView(home, view.p, view.d) : null,
});
