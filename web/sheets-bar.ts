/**
 * The input line a phone gets under 600px, as in the Google Sheets app: the selected cell's value (or formula) is
 * always in a line fixed at the bottom of the screen, and a double tap on a cell (sheets-touch.ts) focuses it, so the
 * keyboard comes up; Enter or the check button puts the text in that cell (a change like any other, saved by
 * sheets.ts). Under it a row of buttons: four arrows move the selection one cell (a value being edited is put in its
 * cell first, as in Google Sheets), the symbols insert their character at the caret; none takes the focus away, so an
 * open keyboard stays open. The row scrolls sideways when it does not fit, the arrows first. The
 * line follows visualViewport, so the keyboard never covers it, and the sheet ends right above it. It is always there
 * and shown only under 600px (CSS), so a Fold folded after opening gets it too.
 */
import { Direction, type createUniver } from "@univerjs/presets";
import { type Report, touchGrid } from "./sheets-touch.ts";

type API = ReturnType<typeof createUniver>["univerAPI"];
type Book = ReturnType<API["createWorkbook"]>;

const SYMBOLS = ["=", "(", ")", ":", "-", "/", "*", ",", "+", "$", "."];
const ARROWS: [string, string, Direction][] = [
  ["↑", "위 칸", Direction.UP],
  ["↓", "아래 칸", Direction.DOWN],
  ["←", "왼쪽 칸", Direction.LEFT],
  ["→", "오른쪽 칸", Direction.RIGHT],
];
const NUMBER = /^-?\d+(\.\d+)?$/;
/** How long after a double tap the input line keeps the focus it took. */
const REFOCUS_MS = 1000;

export function phoneBar(
  api: API,
  book: Book,
  host: HTMLElement,
  box: HTMLElement,
  changed: () => void,
  report: Report,
): void {
  const bar = document.createElement("div");
  bar.className = "shbar";
  bar.innerHTML =
    `<form class="shin"><i aria-hidden="true">fx</i><input id="shinput" autocomplete="off" autocapitalize="off" ` +
    `enterkeyhint="done" placeholder="텍스트 또는 수식 입력" aria-label="칸에 넣을 텍스트 또는 수식">` +
    `<button type="submit" aria-label="확인">✓</button></form><div class="shsym">` +
    ARROWS.map(
      ([s, label], i) => `<button type="button" class="sharr" data-arrow="${i}" aria-label="${label}">${s}</button>`,
    ).join("") +
    SYMBOLS.map((s) => `<button type="button" data-sym="${s}">${s}</button>`).join("") +
    `</div>`;
  document.body.append(bar);
  const form = bar.querySelector("form") as HTMLFormElement;
  const input = bar.querySelector("input") as HTMLInputElement;

  const place = (): void => {
    const v = visualViewport;
    const keyboard = v ? Math.max(0, innerHeight - v.height - v.offsetTop) : 0;
    bar.style.bottom = `${keyboard}px`;
    box.style.paddingBottom = `${bar.offsetHeight + keyboard}px`;
  };
  visualViewport?.addEventListener("resize", place);
  visualViewport?.addEventListener("scroll", place);
  addEventListener("resize", place);
  place();

  /** The active cell only: a selection of several cells still gets the text in its first one, as in Google Sheets. */
  const active = () => {
    const sheet = book.getActiveSheet();
    const r = sheet.getActiveRange();
    return r ? sheet.getRange(r.getRow(), r.getColumn()) : null;
  };
  /** The active cell's value as last put in the line: a different value in the line is an edit not yet put in. */
  let shown = "";
  const fill = (): void => {
    const r = active();
    shown = r ? r.getFormula() || String(r.getValue() ?? "") : "";
    input.value = shown;
  };
  /** Puts the line's text in the active cell. */
  const commit = (): void => {
    const r = active();
    if (!r) return;
    const text = input.value;
    if (text.startsWith("=")) r.setFormula(text);
    else r.setValue(NUMBER.test(text) ? Number(text) : text);
    shown = text;
    changed();
  };
  /** Keeps the focus in the line for a moment: Univer moves it to its hidden editor a little after a selection. */
  const holdFocus = (): void => {
    const back = (e: FocusEvent): void => {
      if (e.target !== input) input.focus();
    };
    document.addEventListener("focusin", back);
    setTimeout(() => document.removeEventListener("focusin", back), REFOCUS_MS);
  };
  api.addEvent(api.Event.SelectionChanged, fill);
  // The cell selected when the sheet opens is not reported as a change.
  api.addEvent(api.Event.LifeCycleChanged, fill);
  touchGrid(
    api,
    book,
    host,
    {
      tap: fill,
      // Univer moves the focus to its hidden editor a moment after the tap that selected the cell: the line takes it back.
      doubleTap: () => {
        fill();
        input.focus();
        holdFocus();
      },
    },
    report,
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    commit();
    input.blur();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    fill();
    input.blur();
  });
  for (const b of bar.querySelectorAll<HTMLButtonElement>("[data-arrow]")) {
    const [, , direction] = ARROWS[Number(b.dataset["arrow"])] as [string, string, Direction];
    // pointerdown's default would move the focus to the button and close the keyboard.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const typing = document.activeElement === input;
      if (input.value !== shown) commit();
      // Univer's own arrow-key move: it skips hidden rows, steps over merged cells and stops at the sheet's edge
      // (allowArrowKeyWrapOnSheetBoundary is off under 600px, sheets.ts). The line follows on SelectionChanged.
      void api.executeCommand("sheet.command.move-selection", { direction });
      if (typing) holdFocus();
    });
  }
  for (const b of bar.querySelectorAll<HTMLButtonElement>("[data-sym]")) {
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const at = input.selectionStart ?? input.value.length;
      input.setRangeText(b.dataset["sym"] ?? "", at, input.selectionEnd ?? at, "end");
      input.focus();
    });
  }
}
