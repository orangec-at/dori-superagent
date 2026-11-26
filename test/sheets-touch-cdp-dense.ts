/**
 * A tap on a phone whose canvas has more pixels than CSS px, at a width other than 412 (PR #86's phone: 475 wide,
 * DPR 2.625), part of sheets-touch-cdp.ts (run last, the sheet still scrolled from its drag): the tap selects the cell
 * under the finger, one row down and one column left of the cell the tap before selected.
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
  /** The row the tap before selected, at the grid's row 5, column C. */
  row: number;
};

/** The top left of Univer's grid canvas (the largest canvas in #sheet). */
export const GRID = `(() => { const [r] = [...document.querySelectorAll("#sheet canvas")].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height); return { x: r.left, y: r.top }; })()`;

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

export async function dense(p: Page): Promise<void> {
  await p.cdp("Emulation.setDeviceMetricsOverride", {
    width: 475,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await sleep(800);
  Object.assign(p.grid, await p.evaluate<P>(GRID));
  await p.touch([p.at(6, 1)]);
  await sleep(400);
  const value = await p.evaluate<string>(`document.getElementById("shinput").value`);
  const want = `B${p.row + 1}`;
  await p.shot("5-tap-475-dpr2.625");
  p.check("tap at 475px, DPR 2.625", value === want, `input line "${value}" (want ${want})`);
}
