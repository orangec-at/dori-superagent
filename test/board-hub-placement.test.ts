import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askAdd } from "../src/asks.ts";
import { projectPane } from "../src/board-projects-html.ts";
import { boardState } from "../src/board-state.ts";
import { Store } from "../src/store.ts";
import { coupas, DAY, lane, NOW, page, V } from "./board-hub-setup.ts";

/** Where the project page puts what is not plainly a lane's: asks, Discord talk, PRs of another repo, PR-led titles. */
test("an ask whose id places nowhere joins the project its question names; one naming none joins no project", () => {
  const store = coupas();
  const ask = (id: string, question: string) =>
    askAdd(store.root, id, { question, options: [{ key: "A", text: "예" }], now: NOW - 60_000 });
  ask("price-check", "coupas 단가를 올릴까요?");
  ask("misc-thing", "점심 메뉴는?");
  const s = boardState(store, NOW);
  expect(s.projects.find((g) => g.name === "coupas")!.asks.map((a) => a.id)).toEqual(["coupas-price", "price-check"]);
  expect(s.projects.flatMap((g) => g.asks.map((a) => a.id))).not.toContain("misc-thing");
  expect(s.asks.map((a) => a.id)).toContain("misc-thing");
});

test("a talk row in the timeline links to its Discord channel", () => {
  const store = coupas();
  const s = boardState(store, NOW);
  const msg = { at: NOW - 3_600_000, author: "마쿤", mine: false, bot: false, text: "가격 올려요" };
  const d = {
    channels: [{ key: "g1:c1", name: "coupas", kind: "channel" as const, messages: [msg] }],
    syncedAt: NOW,
    error: null,
    skipped: [],
  };
  const html = projectPane(s.projects.find((g) => g.name === "coupas")!, s, d, V, NOW, "/");
  const row = html.match(/<li class="k-talk">.*?<\/li>/)?.[0] ?? "";
  expect(row).toMatch(/<a class="tx" href="\/\?tab=proj&amp;d=g1%3Ac1#end" title="마쿤 · #coupas: 가격 올려요">/);
  expect(html).not.toContain('<span class="tx" title="마쿤');
});

test("a PR in another project's repo stays with that project, not the lane's; a repo of no project stays", () => {
  const store = coupas();
  const yd = "https://github.com/orangec-at/yogaday.love/pull/87";
  const lib = "https://github.com/orangec-at/shared-lib/pull/4";
  store.saveLane(
    lane("coupas-growth", "done", NOW - DAY, [{ at: NOW - DAY, kind: "done", text: `참고 ${yd} ${lib}` }]),
  );
  store.saveLane({
    ...lane("yd-info", "done", NOW - DAY, [{ at: NOW - DAY, kind: "done", text: `안내 페이지 ${yd}` }]),
    cwd: "/home/b/workspace/yogaday.love",
  });
  const s = boardState(store, NOW);
  const c = s.projects.find((g) => g.name === "coupas")!;
  expect(c.repos).toEqual(["orangec-at/coupas", "orangec-at/shared-lib"]);
  expect(c.recent.find((l) => l.key === "coupas-growth")!.prs.map((p) => `${p.repo}#${p.num}`)).toEqual([
    "orangec-at/shared-lib#4",
  ]);
  // Only the lane's own report still quotes the URL; the PR list and the repo links do not carry it.
  const html = page(store);
  expect(html).not.toContain('href="https://github.com/orangec-at/yogaday.love"');
  expect(html).not.toMatch(/<li><span class="st [^"]+">[^<]+<\/span><a class="pr" href="[^"]+yogaday\.love/);
  const y = s.projects.find((g) => g.name === "yogaday")!;
  expect(y.repos).toEqual(["orangec-at/yogaday.love"]);
  expect(y.recent[0]!.prs.map((p) => p.num)).toEqual([87]);
});

test("a brief title that only names a PR keeps the lane key in front, so the card names the work", () => {
  const h = mkdtempSync(join(tmpdir(), "dori-hub-prtitle-"));
  const brief = join(h, "brief.md");
  writeFileSync(brief, "# coupas-lows: PR #32(프로젝트 탭) 후속\n");
  const store = new Store(h);
  store.saveLane(lane("coupas-lows", "working", NOW - 600_000, [], brief));
  expect(page(store)).toContain('<p class="hb-p">coupas-lows — PR #32(프로젝트 탭) 후속</p>');
  const other = join(h, "other.md");
  writeFileSync(other, "# coupas-lows: #31 리뷰 LOW 5건\n");
  store.saveLane(lane("coupas-lows", "working", NOW - 600_000, [], other));
  expect(page(store)).toContain('<p class="hb-p">coupas-lows — #31 리뷰 LOW 5건</p>');
});
