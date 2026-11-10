import { inboxRefs } from "./inbox-files.ts";
import { refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Store } from "./store.ts";
import type { ItemStatus, LaneStatus, Role } from "./store-types.ts";

/** What `dori serve` shows at /api/state. Everything is read from the files in DORI_HOME; nothing is written. */
export type DashboardState = {
  generatedAt: number;
  home: string;
  lanes: {
    key: string;
    status: LaneStatus;
    pane: string;
    /** The saved herdr machine the lane's pane runs on, or "local". */
    machine: string;
    lastActivityAt: number;
    log: { at: number; kind: string; text: string }[];
    final: { text: string; evidence: string[]; at: number } | null;
  }[];
  backlog: { id: string; title: string; priority: number; status: ItemStatus; decision: string | null }[];
  roles: { role: Role; pane: string }[];
  inboxes: { pane: string; owner: string | null; queued: number; typed: number; held: number }[];
  receipts: { pr: string; sha: string; verdict: "CLEAR" | "BLOCK"; at: number }[];
  stops: { duty: { at: number; reason: string } | null; loop: { at: number; reason: string } | null };
};

const LOG_LINES = 5;

export function dashboardState(store: Store, now: number): DashboardState {
  const lanes = store.lanes();
  const roles = Object.entries(store.roles()) as [Role, SessionRef][];
  const ownerOf = (ref: SessionRef): string | null =>
    roles.find(([, r]) => sameSession(r, ref))?.[0] ??
    lanes.find((l) => l.status !== "done" && sameSession(l.sessionRef, ref))?.key ??
    null;
  return {
    generatedAt: now,
    home: store.root,
    lanes: lanes.map((l) => ({
      key: l.key,
      status: l.status,
      pane: refText(l.sessionRef),
      machine: l.sessionRef.machine ?? "local",
      lastActivityAt: l.lastActivityAt,
      log: l.log.slice(-LOG_LINES),
      final: l.final ?? null,
    })),
    backlog: store.items().map((i) => ({
      id: i.id,
      title: i.title,
      priority: i.priority,
      status: i.status,
      decision: i.decision ?? null,
    })),
    roles: roles.map(([role, ref]) => ({ role, pane: refText(ref) })),
    inboxes: inboxRefs(store.root).map((ref) => {
      const msgs = store.queued(ref);
      const count = (state: "typed" | "ambiguous" | undefined) => msgs.filter((m) => m.attempt?.state === state).length;
      return {
        pane: refText(ref),
        owner: ownerOf(ref),
        queued: count(undefined),
        typed: count("typed"),
        held: count("ambiguous"),
      };
    }),
    receipts: store.receipts().map((r) => ({ pr: r.pr, sha: r.sha, verdict: r.verdict, at: r.at })),
    stops: { duty: store.stop("duty") ?? null, loop: store.stop("loop") ?? null },
  };
}
