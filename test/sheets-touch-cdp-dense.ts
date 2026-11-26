/**
 * Taps the cell lookup in sheets-touch.ts does not leave to Univer, part of sheets-touch-cdp.ts. `merged` (run before
 * the sheet scrolls): a tap inside a merged cell selects the whole merge, a tap on a row header still selects the row
 * (left to Univer). `dense` (run last, the sheet still scrolled from its drag): on a phone whose canvas has more pixels
 * than CSS px, at a width other than 412 (PR #86's phone: 475 wide, DPR 2.625), the tap selects the cell under the
 * finger, one row down and one column left of the cell the tap before selected.
 */
type P = { x: number; y: number };
type Page = {
  // biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON.
  cdp: (method: string, params?: object) => Promise<any>;
  evaluate: <T>(expression: string) => Promise<T>;
  touch: (path: P[]) => Promise<void>;
  shot: (label: string) => Promise<void>;
  check: (label: string, ok: boolean, detail: string) => void;
  /** The grid's top left, which `at` reads: set again here after the resize. */
  grid: P;
  at: (r: number, c: number) => P;
};

/** The top left of Univer's grid canvas (the largest canvas in #sheet). */
export const GRID = `(() => { const [r] = [...document.querySelectorAll("#sheet canvas")].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height); return { x: r.left, y: r.top }; })()`;
/** C10:D11, away from the cells the other gestures touch. */
export const MERGES = [{ startRow: 9, endRow: 10, startColumn: 2, endColumn: 3 }];

const INPUT = `document.getElementById("shinput").value`;
/** The page's value of `expression` once `done` holds for it, or its last value after 3 seconds. */
const until = <T>(p: Page, expression: string, done: string): Promise<T> =>
  p.evaluate<T>(`new Promise((ok) => {
    const end = performance.now() + 3000;
    const step = () => { const v = ${expression}; if ((${done})(v) || performance.now() > end) ok(v); else requestAnimationFrame(step); };
    step();
  })`);
const tap = async (p: Page, at: P, want: string): Promise<string> => {
  await p.touch([at]);
  return until<string>(p, INPUT, `(v) => v === ${JSON.stringify(want)}`);
};

export async function merged(p: Page): Promise<void> {
  const inMerge = await tap(p, p.at(10, 3), "C10");
  await p.shot("1b-tap-merge-D11");
  p.check("tap in a merge", inMerge === "C10", `input line "${inMerge}" after a tap on D11 in C10:D11 (want C10)`);
  const header = await tap(p, { x: p.grid.x + 23 * 1.1, y: p.at(7, 0).y }, "A8");
  await p.shot("1c-tap-row-header-8");
  p.check("tap on a row header", header === "A8", `input line "${header}" (want A8)`);
}

export async function dense(p: Page & { row: number }): Promise<void> {
  await p.cdp("Emulation.setDeviceMetricsOverride", {
    width: 475,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  // Univer has resized its canvas: as wide as the page, at the new pixel ratio.
  await until(
    p,
    `[...document.querySelectorAll("#sheet canvas")].some((c) => Math.round(c.getBoundingClientRect().width) === 475 && Math.abs(c.width / devicePixelRatio - 475) < 2)`,
    "(v) => v",
  );
  Object.assign(p.grid, await p.evaluate<P>(GRID));
  const want = `B${p.row + 1}`;
  const value = await tap(p, p.at(6, 1), want);
  await p.shot("5-tap-475-dpr2.625");
  p.check("tap at 475px, DPR 2.625", value === want, `input line "${value}" (want ${want})`);
}
