/**
 * One finger on the grid under 600px, as in the Google Sheets app: a drag scrolls the sheet (and glides on after a
 * flick), a tap selects the cell, a second tap on it starts editing it, and holding still selects a range by dragging.
 * Univer's desktop UI (kept so a Fold opened after loading gets it at once) reads a touch as a mouse, so a drag would
 * select a range: the page takes the finger's events before Univer sees them, scrolls with Univer's own
 * set-scroll-relative command and hands a tap or a held drag back to Univer as mouse events.
 */
import type { createUniver } from "@univerjs/presets";

type API = ReturnType<typeof createUniver>["univerAPI"];
type Book = ReturnType<API["createWorkbook"]>;

const PHONE = 600;
/** A finger that moved further than this was scrolling, not tapping. */
const SLOP = 10;
/** Held this long without moving, the finger selects a range instead of scrolling. */
const HOLD_MS = 500;
/** A second tap pressed this soon after the first one lifted, and this close to it, is a double tap. */
const DOUBLE_MS = 350;
const DOUBLE_SLOP = 30;
/** After a flick the sheet glides on, slowing by this much each frame, and stops under STOP px a frame. */
const GLIDE = 0.94;
const STOP = 0.5;
/** A move this much longer on one axis than the other scrolls on that axis only. */
const LOCK = 2;
const SCROLL = "sheet.command.set-scroll-relative";

export function touchGrid(api: API, book: Book, host: HTMLElement, on: { tap(): void; doubleTap(): void }): void {
  let finger: {
    id: number;
    target: EventTarget;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    at: number;
    down: number;
    vx: number;
    vy: number;
    mode: "wait" | "scroll" | "select";
    axis: "x" | "y" | null;
  } | null = null;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let glide = 0;
  let lastTap = { at: 0, x: 0, y: 0 };
  let lastTouch = 0;

  const scrollBy = (dx: number, dy: number): void => {
    const zoom = book.getActiveSheet().getZoom() || 1;
    void api.executeCommand(SCROLL, { offsetX: -dx / zoom, offsetY: -dy / zoom });
  };
  /** The same pointer event as a mouse's, so Univer selects as it does for a click or a mouse drag. */
  const asMouse = (type: string, target: EventTarget, id: number, x: number, y: number): void => {
    const down = type !== "pointerup";
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    target.dispatchEvent(
      new PointerEvent(type, { ...init, buttons: down ? 1 : 0, pointerId: id, pointerType: "mouse", isPrimary: true }),
    );
  };
  const ours = (e: PointerEvent): boolean =>
    e.isTrusted && e.pointerType === "touch" && innerWidth < PHONE && (e.target as Element).tagName === "CANVAS";

  host.addEventListener(
    "pointerdown",
    (e) => {
      if (!ours(e)) return;
      e.stopPropagation();
      cancelAnimationFrame(glide);
      clearTimeout(hold);
      lastTouch = Date.now();
      if (!e.isPrimary) return;
      const f: NonNullable<typeof finger> = {
        id: e.pointerId,
        target: e.target as EventTarget,
        x: e.clientX,
        y: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        at: e.timeStamp,
        down: Date.now(),
        vx: 0,
        vy: 0,
        mode: "wait",
        axis: null,
      };
      finger = f;
      hold = setTimeout(() => {
        if (finger !== f || f.mode !== "wait") return;
        f.mode = "select";
        asMouse("pointerdown", f.target, f.id, f.x, f.y);
      }, HOLD_MS);
    },
    true,
  );
  host.addEventListener(
    "pointermove",
    (e) => {
      if (!ours(e)) return;
      e.stopPropagation();
      const f = finger;
      if (!f || e.pointerId !== f.id) return;
      if (f.mode === "select") {
        asMouse("pointermove", f.target, f.id, e.clientX, e.clientY);
        return;
      }
      const tx = e.clientX - f.x;
      const ty = e.clientY - f.y;
      if (f.mode === "wait") {
        if (Math.hypot(tx, ty) < SLOP) return;
        clearTimeout(hold);
        f.mode = "scroll";
        f.axis = Math.abs(tx) > LOCK * Math.abs(ty) ? "x" : Math.abs(ty) > LOCK * Math.abs(tx) ? "y" : null;
      }
      const dx = f.axis === "y" ? 0 : e.clientX - f.lastX;
      const dy = f.axis === "x" ? 0 : e.clientY - f.lastY;
      const dt = Math.max(1, e.timeStamp - f.at);
      f.vx = (dx / dt) * 16;
      f.vy = (dy / dt) * 16;
      f.lastX = e.clientX;
      f.lastY = e.clientY;
      f.at = e.timeStamp;
      if (dx || dy) scrollBy(dx, dy);
    },
    true,
  );
  const end = (e: PointerEvent): void => {
    if (!ours(e)) return;
    e.stopPropagation();
    const f = finger;
    if (!f || e.pointerId !== f.id) return;
    finger = null;
    clearTimeout(hold);
    lastTouch = Date.now();
    if (e.type === "pointercancel") {
      if (f.mode === "select") asMouse("pointerup", f.target, f.id, f.lastX, f.lastY);
      return;
    }
    if (f.mode === "select") {
      asMouse("pointerup", f.target, f.id, e.clientX, e.clientY);
      return;
    }
    if (f.mode === "scroll") {
      // A finger that stopped before lifting does not glide.
      if (e.timeStamp - f.at > 100) return;
      let { vx, vy } = f;
      const step = (): void => {
        vx *= GLIDE;
        vy *= GLIDE;
        if (Math.hypot(vx, vy) < STOP) return;
        scrollBy(vx, vy);
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
      return;
    }
    const double = f.down - lastTap.at < DOUBLE_MS && Math.hypot(f.x - lastTap.x, f.y - lastTap.y) < DOUBLE_SLOP;
    lastTap = double ? { at: 0, x: 0, y: 0 } : { at: Date.now(), x: f.x, y: f.y };
    // The first tap selected the cell. Handed over too, the second would be Univer's double click, which opens its
    // in-cell editor and takes the focus after the input line took it.
    if (double) {
      on.doubleTap();
      return;
    }
    asMouse("pointerdown", f.target, f.id, f.x, f.y);
    asMouse("pointerup", f.target, f.id, f.x, f.y);
    on.tap();
  };
  host.addEventListener("pointerup", end, true);
  host.addEventListener("pointercancel", end, true);
  // The browser's own double click after a double tap would open Univer's in-cell editor: the input line edits instead.
  host.addEventListener(
    "dblclick",
    (e) => {
      if (innerWidth < PHONE && Date.now() - lastTouch < 1000) e.stopPropagation();
    },
    true,
  );
}
