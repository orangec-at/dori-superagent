import { createHash } from "node:crypto";
import { type BoardState, boardState } from "./board-state.ts";
import type { ChannelSource } from "./channel-source.ts";
import type { Store } from "./store.ts";

const VERSION_REUSE_MS = 2_000;

/**
 * The page's version: what it shows, without the clock. The page polls it and reloads when it changes. Every open tab
 * polls /api/version, so `polled` reuses its answer for a moment and polling cannot make the board re-read its files.
 * `fresh` is the version after a background write (board-inline.ts): the page takes it and the next poll answers the
 * same, so the page does not reload for its own write.
 */
export function boardVersions(store: Store, now: () => number, sources: ChannelSource[]) {
  const of = (s: BoardState): string =>
    createHash("sha256")
      .update(JSON.stringify({ ...s, generatedAt: 0, chans: sources.map((x) => x.stamp()) }))
      .digest("hex")
      .slice(0, 16);
  let last = { at: Number.NEGATIVE_INFINITY, v: "" };
  const fresh = (): string => {
    const at = now();
    last = { at, v: of(boardState(store, at)) };
    return last.v;
  };
  return { of, fresh, polled: (): string => (now() - last.at >= VERSION_REUSE_MS ? fresh() : last.v) };
}
