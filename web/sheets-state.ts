/**
 * The editor's bookkeeping that needs no page, kept apart so it is unit tested (test/board-sheets-client.test.ts).
 */
type Sheets = Record<string, { zoomRatio?: number; [field: string]: unknown }>;
type Workbook = { sheets?: Sheets; [field: string]: unknown };

/** At most this many unanswered saves are named in `lost`. */
export const LOST_MAX = 8;

/** The unanswered saves after one more failed: the newest LOST_MAX, oldest first. */
export const lostAfter = (lost: readonly string[], sid: string): string[] => [...lost, sid].slice(-LOST_MAX);

/** The zoom each sheet was saved with (undefined: none), read before the page changes it for a narrow screen. */
export const zoomsOf = (snapshot: Workbook): Map<string, number | undefined> =>
  new Map(Object.entries(snapshot.sheets ?? {}).map(([k, s]) => [k, s.zoomRatio]));

/** A copy of the workbook to save with every sheet's zoom put back to the one it was opened with. */
export function withZooms(book: Workbook, kept: Map<string, number | undefined>): Workbook {
  const sheets: Sheets = {};
  for (const [k, s] of Object.entries(book.sheets ?? {})) {
    const { zoomRatio: _, ...rest } = s;
    const z = kept.get(k);
    sheets[k] = z === undefined ? rest : { ...rest, zoomRatio: z };
  }
  return book.sheets ? { ...book, sheets } : book;
}
