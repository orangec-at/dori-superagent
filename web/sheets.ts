/**
 * The 시트 tab's editor, bundled by `bun run build:sheets` into assets/board/sheets.js and sheets.css (no CDN): it opens
 * the sheet the page embeds in Univer and saves its snapshot to POST /sheets a moment after each change, with the rev
 * it opened (the board refuses a save from an older rev with 409, so two places cannot overwrite each other). A viewer
 * without a write token gets the sheet read-only.
 */
import "@univerjs/preset-sheets-core/lib/index.css";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import koKR from "@univerjs/preset-sheets-core/locales/ko-KR";
import { CommandType, createUniver, LocaleType, mergeLocales } from "@univerjs/presets";

const SAVE_AFTER_MS = 1500;
/** A keepalive fetch (the page being hidden or left) may carry at most 64 KiB. */
const KEEPALIVE_MAX = 60_000;

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
    presets: [UniverSheetsCorePreset({ container: host })],
  });
  const book = univerAPI.createWorkbook(JSON.parse(data.textContent ?? "{}"));
  const say = (text: string, bad = false): void => {
    state.textContent = text;
    state.classList.toggle("bad", bad);
  };

  let saved = JSON.stringify(book.save());
  let dirty = false;
  let saving = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function save(): Promise<void> {
    clearTimeout(timer);
    if (!dirty || saving || stopped) return;
    dirty = false;
    const snapshot = JSON.stringify(book.save());
    if (snapshot === saved) return say("저장했어요");
    saving = true;
    say("저장 중…");
    const body = new URLSearchParams({ csrf, action: "save", id, rev: String(rev), snapshot });
    let retry = false;
    try {
      const res = await fetch("/sheets", {
        method: "POST",
        body,
        headers: { accept: "application/json" },
        cache: "no-store",
        keepalive: document.hidden && body.toString().length < KEEPALIVE_MAX,
      });
      if (res.ok) {
        rev = Number(((await res.json()) as { rev: number }).rev);
        saved = snapshot;
        say(dirty ? "고친 내용 있음" : "저장했어요");
        retry = dirty;
      } else if (res.status === 409) {
        // Saved elsewhere since this page opened: nothing more is saved from here, so neither copy is overwritten.
        stopped = true;
        book.setEditable(false);
        say("다른 곳에서 먼저 저장했어요. 여기서 고친 것은 저장되지 않았어요. 새로 불러와 주세요.", true);
      } else {
        dirty = true;
        say(
          res.status === 403
            ? "저장하지 못했어요: 허용된 계정·기기가 아니거나 화면이 오래됐어요. 새로 불러와 주세요."
            : `저장하지 못했어요 (${res.status} ${(await res.text()).trim()}).`,
          true,
        );
      }
    } catch {
      dirty = true;
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
    button?.addEventListener("click", () => {
      void save();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void save();
    });
    addEventListener("beforeunload", (e) => {
      if (dirty || saving) e.preventDefault();
    });
  }
}
