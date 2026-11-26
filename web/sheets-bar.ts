/**
 * The input line a phone gets under 600px, as in the Google Sheets app: tapping a cell puts its value (or formula) in a
 * line fixed at the bottom of the screen and focuses it, so the keyboard comes up at once; Enter or the check button
 * puts the text in that cell (a change like any other, saved by sheets.ts). Under it a row of symbol buttons inserts
 * its character at the caret without taking the focus away. The line follows visualViewport, so the keyboard never
 * covers it.
 */
import type { createUniver } from "@univerjs/presets";

type API = ReturnType<typeof createUniver>["univerAPI"];
type Book = ReturnType<API["createWorkbook"]>;

const SYMBOLS = ["=", "(", ")", ":", "-", "/", "*", ",", "+", "$", "."];
/** A finger that moved further than this between down and up was scrolling the grid, not tapping a cell. */
const TAP_SLOP = 10;
const NUMBER = /^-?\d+(\.\d+)?$/;

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

  const active = () => book.getActiveSheet().getActiveRange();
  const fill = (): void => {
    const r = active();
    input.value = r ? r.getFormula() || String(r.getValue() ?? "") : "";
  };
  api.addEvent(api.Event.SelectionChanged, fill);

  let down: { x: number; y: number } | null = null;
  host.addEventListener(
    "pointerdown",
    (e) => {
      down = { x: e.clientX, y: e.clientY };
    },
    true,
  );
  host.addEventListener(
    "pointerup",
    (e) => {
      const tap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_SLOP;
      down = null;
      if (!tap) return;
      // After Univer's own handling of the same tap, which moves the selection (and the focus to its hidden editor).
      setTimeout(() => {
        fill();
        input.focus();
      }, 0);
    },
    true,
  );

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
