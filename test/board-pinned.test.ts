import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewOf } from "../src/board-list-html.ts";
import { projectSeeds } from "../src/board-projects.ts";
import { projectPane, projectsList, unreadAts } from "../src/board-projects-html.ts";
import { boardState } from "../src/board-state.ts";
import { Store } from "../src/store.ts";
import type { DiscordChannel, DiscordView } from "../src/discord-sync.ts";

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const PROJECTS = {
  토스인앱: {
    words: ["tossinapp", "word-pet", "토스인앱"],
    dirs: ["tossinapp"],
    note: "앱인토스 미니앱 — 영어 말하기·영단어(단어펫 word-pet)",
  },
  corpus: { words: ["corpus"], repos: ["orangec-at/corpus"], note: "corpus" },
  "Supabase 지원": {
    words: ["supabase-job", "career-ops"],
    note: "Supabase Frontend Engineer (Remote, Anywhere) 지원",
    links: [{ label: "공고", url: "https://jobs.ashbyhq.com/supabase/f048dd68-63f8-4f98-9860-3d5a43c09a01" }],
  },
  old: ["legacy-word"],
  noWords: { words: "corpus" },
  badRepo: { repos: ["not a repo"] },
  badLink: { links: [{ label: "x", url: "javascript:alert(1)" }] },
  badNote: { note: 3 },
  scalar: "nope",
  nul: null,
};

const home = (projects: unknown = PROJECTS): string => {
  const h = mkdtempSync(join(tmpdir(), "dori-pinned-"));
  writeFileSync(join(h, "board.json"), JSON.stringify({ projects }));
  return h;
};

test("board.json projects take the word-list and the object form; an entry of any other shape is ignored", () => {
  const seeds = projectSeeds(home());
  expect(seeds.map((s) => s.name)).toEqual(["토스인앱", "corpus", "Supabase 지원", "old"]);
  expect(seeds[0]).toMatchObject({ words: ["tossinapp", "word-pet", "토스인앱"], dirs: ["tossinapp"], links: [] });
  expect(seeds[1]).toMatchObject({ repos: ["orangec-at/corpus"], note: "corpus" });
  expect(seeds[2]?.links).toEqual([PROJECTS["Supabase 지원"].links[0]!]);
  expect(seeds[3]).toMatchObject({ words: ["legacy-word"], repos: [], note: null, links: [] });
});

test("a seeded project with no work is listed after the active ones, its page showing its note, links and repos", () => {
  const h = home();
  const store = new Store(h);
  store.saveLane({
    key: "drht-disk",
    sessionRef: { runtime: "herdr", id: "w1:p1" },
    paneId: "w1:p1",
    tabId: "",
    brief: "/b.md",
    cwd: "/home/b/workspace/drawhatha",
    status: "working",
    createdAt: NOW - 60_000,
    lastActivityAt: NOW - 60_000,
    nudges: 0,
    log: [],
  });
  const s = boardState(store, NOW);
  expect(s.projects.map((g) => g.name)).toEqual(["drawhatha", "토스인앱", "corpus", "Supabase 지원", "old"]);
  const v = viewOf(new URLSearchParams("tab=proj"));
  const list = projectsList(s, null, v, NOW);
  expect(list).toContain("앱인토스 미니앱 — 영어 말하기·영단어(단어펫 word-pet) · 진행 중인 일 없음");
  const supa = projectPane(s.projects.find((g) => g.name === "Supabase 지원")!, s, null, v, NOW, "/");
  expect(supa).toContain('href="https://jobs.ashbyhq.com/supabase/f048dd68-63f8-4f98-9860-3d5a43c09a01"');
  expect(supa).toContain("Supabase Frontend Engineer (Remote, Anywhere) 지원");
  expect(supa).toContain("진행 중인 일 없음");
  const corpus = projectPane(s.projects.find((g) => g.name === "corpus")!, s, null, v, NOW, "/");
  expect(corpus).toContain('href="https://github.com/orangec-at/corpus"');
  expect(projectPane(s.projects[0]!, s, null, v, NOW, "/")).not.toContain("진행 중인 일 없음");
});

const chan = (key: string, mine: boolean[]): DiscordChannel => ({
  key,
  name: key,
  kind: "channel",
  messages: mine.map((m, i) => ({
    at: NOW - 1000 * (mine.length - i),
    author: m ? "me" : "bot",
    mine: m,
    bot: !m,
    text: `m${i}`,
  })),
});

test("a channel's new messages are the others' after the operator last wrote there", () => {
  expect(unreadAts(chan("a", [false, false]))).toEqual([NOW - 2000, NOW - 1000]);
  expect(unreadAts(chan("b", [false, true, false]))).toEqual([NOW - 1000]);
  expect(unreadAts(chan("c", [false, true]))).toEqual([]);
});

test("the 프로젝트 tab lists the channels, with their new-message count, above the projects", () => {
  const s = boardState(new Store(home({ corpus: ["corpus"] })), NOW);
  const d: DiscordView = {
    channels: [chan("dori", [false, false, false]), chan("fmv", [false, true])],
    syncedAt: NOW,
    error: null,
    skipped: [],
  };
  const list = projectsList(s, d, viewOf(new URLSearchParams("tab=proj")), NOW);
  expect(list.indexOf("#dori")).toBeLessThan(list.indexOf("corpus"));
  expect(list).toContain('data-d="dori" data-ats="');
  expect(list).toMatch(/data-d="dori"[^>]*>3</);
  expect(list).toMatch(/data-d="fmv"[^>]*hidden>0</);
  const locked = projectsList(s, "locked", viewOf(new URLSearchParams("tab=proj")), NOW);
  expect(locked.indexOf("허용된 계정·기기로")).toBeLessThan(locked.indexOf("corpus"));
});
