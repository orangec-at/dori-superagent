/**
 * The arrow buttons over a phone's keyboard, part of sheets-touch-cdp.ts (run before any tap, A1 selected): the
 * keyboard is up (the input line has the focus) and stays up, each arrow moves the selection one cell and the line
 * follows, ↑ on the first row stays, and a value being edited is put in its cell before moving.
 */
type P = { x: number; y: number };
type Cells = { sheets?: { s1?: { cellData?: Record<number, Record<number, { v?: unknown }>> } } };
type Page = {
  evaluate: <T>(expression: string) => Promise<T>;
  touch: (path: P[]) => Promise<void>;
  shot: (label: string) => Promise<void>;
  check: (label: string, ok: boolean, detail: string) => void;
  // biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON.
  cdp: (method: string, params?: object) => Promise<any>;
  saveNext: () => Promise<unknown>;
};

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

export async function arrows(p: Page): Promise<void> {
  const press = async (label: string): Promise<void> => {
    const at = await p.evaluate<P>(
      `(() => { const r = document.querySelector('.shsym [aria-label="${label}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await p.touch([at]);
    await sleep(300);
  };
  const where = (): Promise<string> =>
    p.evaluate(`document.getElementById("shinput").value + "#" + (document.activeElement?.id ?? "")`);
  await p.evaluate(`document.getElementById("shinput").focus()`);
  const walk = [await where()];
  for (const label of ["위 칸", "아래 칸", "오른쪽 칸", "오른쪽 칸", "아래 칸"]) {
    await press(label);
    walk.push(await where());
  }
  await p.shot("0-arrows-C3");
  p.check(
    "arrows",
    walk.join(" ") === "A1#shinput A1#shinput A2#shinput B2#shinput C2#shinput C3#shinput",
    `↑↓→→↓ from A1: ${walk.join(" ")} (want A1 A1 A2 B2 C2 C3, all #shinput)`,
  );
  const saved = p.saveNext();
  await p.evaluate(
    `(() => { const i = document.getElementById("shinput"); i.setSelectionRange(i.value.length, i.value.length); })()`,
  );
  await p.cdp("Input.insertText", { text: "x" });
  await press("아래 칸");
  const moved = await where();
  const c3 = ((await saved) as Cells | null)?.sheets?.s1?.cellData?.[2]?.[2]?.v;
  await p.shot("0b-arrow-commits-C3");
  p.check(
    "arrow commits",
    c3 === "C3x" && moved === "C4#shinput",
    `C3 saved "${c3}", line ${moved} (want C3x, C4#shinput)`,
  );
  await p.evaluate(`document.getElementById("shinput").blur()`);
  await sleep(200);
}
