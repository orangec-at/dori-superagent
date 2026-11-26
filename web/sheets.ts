/**
 * The 시트 tab's editor, bundled by `bun run build:sheets` into assets/board/sheets.js and sheets.css (no CDN): it opens
 * the sheet the page embeds in Univer and saves its snapshot to POST /sheets a moment after each change, with the rev
 * it opened (the board refuses a save from an older rev with 409, so two places cannot overwrite each other). A viewer
 * without a write token gets the sheet read-only.
 *
 * Each save carries its own id (sid). One whose answer never came (the connection dropped, often while the page was
 * hidden) may still have been written, so the next save names it in `lost` and the board goes on from it instead of
 * answering 409. A failure is reported to the board (action=clientlog: kind, status, message, width, hidden; no cell
 * text), and one sent while the page was hidden is sent again once it shows.
 *
 * Under 600px (a folded Fold, a phone) the ribbon and formula bar are hidden and a tapped cell is edited in the input
 * line at the bottom (sheets-bar.ts); up to 1024px the ribbon is collapsed and the cells drawn a little larger. Only
 * Univer's open source options, its facade and the sheet's zoom are used.
 */
import "@univerjs/preset-sheets-core/lib/index.css";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import koKR from "@univerjs/preset-sheets-core/locales/ko-KR";
import { CommandType, createUniver, LifecycleStages, LocaleType, mergeLocales } from "@univerjs/presets";
import { phoneBar } from "./sheets-bar.ts";
import { lostAfter, withZooms, zoomsOf } from "./sheets-state.ts";

const SAVE_AFTER_MS = 1500;
/** A keepalive fetch (the page being hidden or left) may carry at most 64 KiB. */
const KEEPALIVE_MAX = 60_000;
const PHONE = 600;
const WIDE = 1024;
const zoomFor = (w: number): number => (w < PHONE ? 1.1 : w < WIDE ? 1.15 : 1);

const box = document.querySelector<HTMLElement>("[data-sheet]");
const host = document.getElementById("sheet");
const data = document.getElementById("sheet-data");
const state = document.getElementById("shs");
const button = document.getElementById("shsave");

if (box && host && data && state) {
  const id = box.dataset["sheet"] ?? "";
  const csrf = box.dataset["csrf"] ?? "";
  let rev = Number(box.dataset["rev"] ?? "0");
  const { univerAPI } = createUniver({
    locale: LocaleType.KO_KR,
    locales: { [LocaleType.KO_KR]: mergeLocales(koKR) },
    presets: [
      UniverSheetsCorePreset({
        container: host,
        ...(innerWidth < PHONE
          ? { toolbar: false, formulaBar: false, footer: { statisticBar: false, menus: false } }
          : innerWidth < WIDE
            ? { ribbonType: "collapsed" as const, footer: { statisticBar: false } }
            : {}),
      }),
    ],
  });
  // Under 1024px each sheet is drawn at the zoom for this screen: set in the snapshot when opening (zoomRatio is the
  // sheet's own view setting, so it is not a change), with the facade's zoom() when the width changes (a Fold opened),
  // and back to the saved zoom at 1024px or more. While a screen zoom is applied, every save puts the saved one back.
  const snapshot = JSON.parse(data.textContent ?? "{}") as Parameters<typeof zoomsOf>[0];
  const kept = zoomsOf(snapshot);
  let applied: number | null = innerWidth < WIDE ? zoomFor(innerWidth) : null;
  if (applied !== null) for (const s of Object.values(snapshot.sheets ?? {})) s.zoomRatio = applied;
  const book = univerAPI.createWorkbook(snapshot);
  const snap = (): string => {
    const out = book.save() as unknown as Parameters<typeof withZooms>[0];
    return JSON.stringify(applied === null ? out : withZooms(out, kept));
  };
  const fit = (): void => {
    const want = innerWidth < WIDE ? zoomFor(innerWidth) : null;
    if (want === applied) return;
    applied = want;
    for (const s of book.getSheets()) s.zoom(want ?? kept.get(s.getSheetId()) ?? 1);
  };
  addEventListener("resize", fit);
  // Univer reports a selection (which the phone's input line follows) only from this stage on: the page says so.
  univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }) => {
    if (stage === LifecycleStages.Steady) host.dataset["ready"] = "";
  });
  const say = (text: string, bad = false): void => {
    state.textContent = text;
    state.classList.toggle("bad", bad);
  };

  let saved = snap();
  let dirty = false;
  let saving = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sids of the saves since the last answered one whose answer never came. */
  let lost: string[] = [];
  /** A save sent while hidden failed: send again once the page shows. */
  let againOnShow = false;
  const sidOf = (): string =>
    [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  /** One line in the board's log about a failed save; a report that cannot be sent is dropped. */
  const report = (kind: string, status: number, message: string, hidden: boolean): void => {
    const form = { csrf, action: "clientlog", id, kind, status: String(status), message: message.slice(0, 200) };
    const body = new URLSearchParams({ ...form, vw: String(innerWidth), hidden: hidden ? "1" : "0" });
    fetch("/sheets", { method: "POST", body, cache: "no-store", keepalive: true }).catch(() => {});
  };

  async function save(): Promise<void> {
    clearTimeout(timer);
    if (!dirty || saving || stopped) return;
    dirty = false;
    const snapshot = snap();
    if (snapshot === saved) return say("저장했어요");
    saving = true;
    say("저장 중…");
    const sid = sidOf();
    const body = new URLSearchParams({
      csrf,
      action: "save",
      id,
      rev: String(rev),
      sid,
      lost: lost.join(","),
      snapshot,
    });
    const hidden = document.hidden;
    const keepalive = hidden && body.toString().length < KEEPALIVE_MAX;
    const failed = (kind: string, status: number, message: string): void => {
      dirty = true;
      lost = lostAfter(lost, sid);
      if (hidden) againOnShow = true;
      report(kind, status, message, hidden);
    };
    let retry = false;
    try {
      const res = await fetch("/sheets", {
        method: "POST",
        body,
        headers: { accept: "application/json" },
        cache: "no-store",
        keepalive,
      });
      if (res.ok) {
        rev = Number(((await res.json()) as { rev: number }).rev);
        saved = snapshot;
        lost = [];
        say(dirty ? "고친 내용 있음" : "저장했어요");
        retry = dirty;
      } else if (res.status === 409) {
        // Saved elsewhere since this page opened: nothing more is saved from here, so neither copy is overwritten.
        stopped = true;
        book.setEditable(false);
        say("다른 곳에서 먼저 저장했어요. 여기서 고친 것은 저장되지 않았어요. 새로 불러와 주세요.", true);
      } else {
        const why = (await res.text()).trim();
        failed("http", res.status, why);
        say(
          res.status === 403
            ? "저장하지 못했어요: 허용된 계정·기기가 아니거나 화면이 오래됐어요. 새로 불러와 주세요."
            : `저장하지 못했어요 (${res.status} ${why}).`,
          true,
        );
      }
    } catch (e) {
      failed(keepalive ? "keepalive" : "network", 0, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      say("연결이 끊겨 저장하지 못했어요. [저장]을 눌러 다시 보내 주세요.", true);
    }
    saving = false;
    if (retry) timer = setTimeout(save, SAVE_AFTER_MS);
  }

  if (csrf === "") {
    book.setEditable(false);
    say("읽기 전용이에요. 허용된 계정·기기로 열어야 고칠 수 있어요.");
    button?.setAttribute("hidden", "");
  } else {
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
      // The formula engine and the cell editor's own document also run mutations (one each on opening): not a change.
      if (e.type !== CommandType.MUTATION || !e.id.startsWith("sheet.mutation.") || stopped) return;
      dirty = true;
      say("고친 내용 있음");
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_AFTER_MS);
    });
    phoneBar(univerAPI, book, host, box, () => setTimeout(save, 0));
    button?.addEventListener("click", () => {
      void save();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return void save();
      if (!againOnShow) return;
      againOnShow = false;
      report("retry", 0, "shown again after a failed hidden save", false);
      void save();
    });
    addEventListener("beforeunload", (e) => {
      if (dirty || saving) e.preventDefault();
    });
  }
}
