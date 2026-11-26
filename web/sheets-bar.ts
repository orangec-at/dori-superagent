/**
 * The input line a phone gets under 600px, as in the Google Sheets app: tapping a cell puts its value (or formula) in a
 * line fixed at the bottom of the screen and focuses it, so the keyboard comes up at once; Enter or the check button
 * puts the text in that cell (a change like any other, saved by sheets.ts). Under it a row of symbol buttons inserts
 * its character at the caret without taking the focus away. The line follows visualViewport, so the keyboard never
 * covers it. It is always there and shown only under 600px (CSS), so a Fold folded after opening gets it too.
 */
import type { createUniver } from "@univerjs/presets";

type API = ReturnType<typeof createUniver>["univerAPI"];
type Book = ReturnType<API["createWorkbook"]>;

const SYMBOLS = ["=", "(", ")", ":", "-", "/", "*", ",", "+", "$", "."];
/** A finger that moved further than this between down and up was scrolling the grid, not tapping a cell. */
const TAP_SLOP = 10;
const NUMBER = /^-?\d+(\.\d+)?$/;
const PHONE = 600;
/** A tap that selected nothing (the sheet bar, a menu, a scrollbar) stops counting this long after the finger lifts. */
const TAP_FORGET_MS = 100;

export function phoneBar(api: API, book: Book, host: HTMLElement, box: HTMLElement, changed: () => void): void {
  const bar = document.createElement("div");
  bar.className = "shbar";
  bar.innerHTML =
    `<form class="shin"><i aria-hidden="true">fx</i><input id="shinput" autocomplete="off" autocapitalize="off" ` +
    `enterkeyhint="done" placeholder="텍스트 또는 수식 입력" aria-label="칸에 넣을 텍스트 또는 수식">` +
    `<button type="submit" aria-label="확인">✓</button></form><div class="shsym">` +
    SYMBOLS.map((s) => `<button type="button" data-sym="${s}">${s}</button>`).join("") +
    `</div>`;
  document.body.append(bar);
  const form = bar.querySelector("form") as HTMLFormElement;
  const input = bar.querySelector("input") as HTMLInputElement;

  const place = (): void => {
    const v = visualViewport;
    bar.style.bottom = `${v ? Math.max(0, innerHeight - v.height - v.offsetTop) : 0}px`;
    box.style.paddingBottom = `${bar.offsetHeight}px`;
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
  const fill = (): void => {
    const r = active();
    input.value = r ? r.getFormula() || String(r.getValue() ?? "") : "";
  };
  api.addEvent(api.Event.SelectionChanged, fill);

  // A selection ending on the grid (Univer's own pointerup, which also moved the focus to its hidden editor) focuses
  // the line, unless the finger moved: that was a scroll. A tap on the sheet bar, a menu or a scrollbar selects nothing.
  let down: { x: number; y: number } | null = null;
  let tap = false;
  host.addEventListener(
    "pointerdown",
    (e) => {
      down = { x: e.clientX, y: e.clientY };
      tap = false;
    },
    true,
  );
  host.addEventListener(
    "pointerup",
    (e) => {
      tap = down !== null && Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_SLOP;
      down = null;
      // Univer ends the selection on the same pointerup, before or after this; its focus step below runs first.
      setTimeout(() => {
        tap = false;
      }, TAP_FORGET_MS);
    },
    true,
  );
  api.addEvent(api.Event.SelectionMoveEnd, () => {
    setTimeout(() => {
      if (!tap || innerWidth >= PHONE) return;
      tap = false;
      fill();
      input.focus();
    }, 0);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const r = active();
    if (!r) return;
    const text = input.value;
    if (text.startsWith("=")) r.setFormula(text);
    else r.setValue(NUMBER.test(text) ? Number(text) : text);
    input.blur();
    changed();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    fill();
    input.blur();
  });
  for (const b of bar.querySelectorAll<HTMLButtonElement>("[data-sym]")) {
    // pointerdown's default would move the focus to the button and close the keyboard.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const at = input.selectionStart ?? input.value.length;
      input.setRangeText(b.dataset["sym"] ?? "", at, input.selectionEnd ?? at, "end");
      input.focus();
    });
  }
}
