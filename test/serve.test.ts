import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { serveDashboard } from "../src/serve.ts";
import type { DashboardState } from "../src/serve-state.ts";
import { Store } from "../src/store.ts";
import type { Item, Lane } from "../src/store-types.ts";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
let server: Server<undefined> | undefined;
let root: string | undefined;

afterEach(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
  server = root = undefined;
});

const lane = (key: string, over: Partial<Lane>): Lane => ({
  key,
  sessionRef: { runtime: "herdr", id: "w1:p5", container: "w1:t2" },
  paneId: "w1:p5",
  tabId: "w1:t2",
  brief: `/b/${key}.md`,
  cwd: "/repo",
  status: "working",
  createdAt: NOW - 3_600_000,
  lastActivityAt: NOW - 60_000,
  nudges: 0,
  log: [],
  ...over,
});

const item = (id: string, over: Partial<Item>): Item => ({
  id,
  title: `title of ${id}`,
  brief: `/b/${id}.md`,
  cwd: "/repo",
  priority: 5,
  status: "open",
  attempts: 0,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  log: [],
  ...over,
});

function fakeHome(): Store {
  root = mkdtempSync(join(tmpdir(), "dori-serve-"));
  const store = new Store(root);
  store.setRole("lead", { runtime: "herdr", id: "w1:p1" });
  store.setRole("duty", { runtime: "hc", id: "t7" });
  const log = Array.from({ length: 7 }, (_, n) => ({
    at: NOW - (7 - n) * 1000,
    kind: "report" as const,
    text: `step ${n}`,
  }));
  store.saveLane(lane("fix-login", { log }));
  store.saveLane(
    lane("ship-it", {
      sessionRef: { runtime: "hc", id: "t9" },
      status: "ready",
      final: { text: "merged", evidence: ["https://github.com/o/r/pull/1", "javascript:alert(1)"], at: NOW - 5000 },
    }),
  );
  store.saveItem(item("next-thing", { priority: 2, decision: "which API?" }));
  store.saveItem(item("old-thing", { status: "done", createdAt: NOW - 2000 }));
  store.enqueue({ runtime: "herdr", id: "w1:p1" }, { at: NOW - 3000, from: "fix-login", text: "a" });
  store.enqueue(
    { runtime: "herdr", id: "w1:p1" },
    { at: NOW - 2000, from: "cli", text: "b", attempt: { at: NOW, state: "typed" } },
  );
  store.enqueue(
    { runtime: "herdr", id: "w1:p5" },
    { at: NOW - 1000, from: "duty", text: "c", attempt: { at: NOW, state: "ambiguous" } },
  );
  store.saveReceipt({ pr: "o/r#1", sha: "abc123", verdict: "CLEAR", model: "m", at: NOW - 4000, summary: "ok" });
  store.saveReceipt({ pr: "o/r#2", sha: "def456", verdict: "BLOCK", model: "m", at: NOW - 100, summary: "no" });
  store.setStop(NOW - 9000, "operator pause", "duty");
  return store;
}

const start = (store: Store): string => {
  server = serveDashboard(store, { host: "127.0.0.1", port: 0, now: () => NOW });
  return server.url.href.replace(/\/$/, "");
};

test("/api/state reports lanes, backlog, roles, inbox counts, receipts and kill switches from DORI_HOME", async () => {
  const url = start(fakeHome());
  const res = await fetch(`${url}/api/state`);
  expect(res.status).toBe(200);
  const s = (await res.json()) as DashboardState;
  expect(s.generatedAt).toBe(NOW);
  expect(s.lanes.map((l) => [l.key, l.status, l.pane])).toEqual([
    ["fix-login", "working", "w1:p5"],
    ["ship-it", "ready", "hc:t9"],
  ]);
  expect(s.lanes[0]!.lastActivityAt).toBe(NOW - 60_000);
  expect(s.lanes[0]!.log.map((e) => e.text)).toEqual(["step 2", "step 3", "step 4", "step 5", "step 6"]);
  expect(s.lanes[0]!.final).toBeNull();
  expect(s.lanes[1]!.final?.evidence).toEqual(["https://github.com/o/r/pull/1", "javascript:alert(1)"]);
  expect(s.backlog).toEqual([
    { id: "old-thing", title: "title of old-thing", priority: 5, status: "done", decision: null },
    { id: "next-thing", title: "title of next-thing", priority: 2, status: "open", decision: "which API?" },
  ]);
  expect(s.roles).toEqual([
    { role: "lead", pane: "w1:p1" },
    { role: "duty", pane: "hc:t7" },
  ]);
  expect(s.inboxes.sort((a, b) => a.pane.localeCompare(b.pane))).toEqual([
    { pane: "w1:p1", owner: "lead", queued: 1, typed: 1, held: 0 },
    { pane: "w1:p5", owner: "fix-login", queued: 0, typed: 0, held: 1 },
  ]);
  expect(s.receipts).toEqual([
    { pr: "o/r#2", sha: "def456", verdict: "BLOCK", at: NOW - 100 },
    { pr: "o/r#1", sha: "abc123", verdict: "CLEAR", at: NOW - 4000 },
  ]);
  expect(s.stops).toEqual({ duty: { at: NOW - 9000, reason: "operator pause" }, loop: null });
});

test("the HTML page refreshes every 30s, loads nothing external, escapes text and links only http(s) evidence", async () => {
  const url = start(fakeHome());
  const res = await fetch(`${url}/`);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain('<meta http-equiv="refresh" content="30">');
  expect(html).not.toMatch(/<(script|link)\b/);
  expect(html).not.toMatch(/src="/);
  expect(html).toContain('<a href="https://github.com/o/r/pull/1">');
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("STOPPED");
  expect(html).toContain("which API?");
});

test("it is read-only: no write method is served and serving writes no file into DORI_HOME", async () => {
  const store = fakeHome();
  const listing = () => readdirSync(store.root, { recursive: true }).map(String).sort();
  const before = listing();
  const url = start(store);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"])
    expect((await fetch(`${url}/api/state`, { method })).status).toBe(405);
  expect((await fetch(`${url}/nope`)).status).toBe(404);
  await fetch(`${url}/`);
  await fetch(`${url}/api/state`);
  expect(listing()).toEqual(before);
});
