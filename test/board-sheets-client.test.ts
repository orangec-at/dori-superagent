import { expect, test } from "bun:test";
import { LOST_MAX, lostAfter, withZooms, zoomsOf } from "../web/sheets-state.ts";

test("the unanswered saves keep the newest LOST_MAX in order", () => {
  let lost: string[] = [];
  for (let i = 0; i < LOST_MAX + 3; i++) lost = lostAfter(lost, `s${i}`);
  expect(lost).toEqual(Array.from({ length: LOST_MAX }, (_, i) => `s${i + 3}`));
  expect(lostAfter([], "a")).toEqual(["a"]);
});

test("a save made under a screen zoom carries each sheet's zoom from when it was opened", () => {
  const opened = { sheets: { a: { zoomRatio: 1.6 }, b: {} } };
  const kept = zoomsOf(opened);
  const saved = { id: "w", sheets: { a: { zoomRatio: 1.1, cellData: { 0: {} } }, b: { zoomRatio: 1.1 } } };
  expect(withZooms(saved, kept)).toEqual({ id: "w", sheets: { a: { zoomRatio: 1.6, cellData: { 0: {} } }, b: {} } });
  // A sheet added on the phone has no zoom of its own to go back to.
  expect(withZooms({ sheets: { c: { zoomRatio: 1.1 } } }, kept)).toEqual({ sheets: { c: {} } });
  expect(withZooms({ id: "x" }, kept)).toEqual({ id: "x" });
  expect(saved.sheets.a.zoomRatio).toBe(1.1);
});
