import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_MS, sweepStale } from "./tmp-sweep.ts";

let base = "";
afterEach(() => rmSync(base, { recursive: true, force: true }));

const dirAged = (name: string, ageMs: number): string => {
  const path = join(base, name);
  mkdirSync(path);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
};

test("sweepStale removes only this user's test-prefixed dirs older than an hour", () => {
  base = mkdtempSync(join(tmpdir(), "sweep-"));
  const uid = process.getuid?.();
  const old = dirAged("dori-test-old", STALE_MS + 60_000);
  const oldRun = dirAged("dori-run-old", STALE_MS + 60_000);
  const fresh = dirAged("dori-test-fresh", 60_000);
  const foreign = dirAged("dori-self-update-x", STALE_MS + 60_000);
  const other = dirAged("other-program", STALE_MS + 60_000);
  writeFileSync(join(base, "dori-test-file"), "x");
  utimesSync(join(base, "dori-test-file"), 0, 0);

  expect(sweepStale(base, uid).sort()).toEqual(["dori-run-old", "dori-test-old"]);
  expect([existsSync(old), existsSync(oldRun)]).toEqual([false, false]);
  expect([existsSync(fresh), existsSync(foreign), existsSync(other)]).toEqual([true, true, true]);
  expect(existsSync(join(base, "dori-test-file"))).toBe(true);
});

test("sweepStale leaves another user's dirs alone", () => {
  base = mkdtempSync(join(tmpdir(), "sweep-"));
  const old = dirAged("dori-test-old", STALE_MS + 60_000);
  expect(sweepStale(base, (process.getuid?.() ?? 0) + 1)).toEqual([]);
  expect(sweepStale(base, undefined)).toEqual([]);
  expect(existsSync(old)).toBe(true);
});
