import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  messageProject,
  projectAliases,
  projectResolver,
  projectSeeds,
  repoOfCwd,
  type Subject,
} from "../src/board-projects.ts";
import { chanProject, channelProject } from "../src/board-projects-html.ts";
import type { ProjectGroup } from "../src/board-state.ts";

const W = "/home/b/workspace";
const s = (key: string, cwd = W, repos: string[] = []): Subject => ({ key, cwd, repos });

test("a cwd names the repo directory below workspace, without personal/, -worktrees or a domain suffix", () => {
  expect(repoOfCwd(`${W}/personal/vibeguard.run-worktrees/vg-issue-4`)).toBe("vibeguard");
  expect(repoOfCwd("/Users/mac/workspace/drawhatha-worktrees/ios")).toBe("drawhatha");
  expect(repoOfCwd(`${W}/personal/yogaday.love`)).toBe("yogaday");
  expect(repoOfCwd(W)).toBeNull();
  expect(repoOfCwd("/archive")).toBeNull();
});

test("projects come from leads.json, cwds, PR repos and key prefixes the other work taught; the rest is 기타", () => {
  const home = mkdtempSync(join(tmpdir(), "dori-projects-"));
  writeFileSync(
    join(home, "leads.json"),
    JSON.stringify([{ domain: "vibeguard", keyPrefixes: ["vg-issue-", "fmv-"], repos: ["vibeguard-run/web"] }]),
  );
  const work = [
    s("vg-issue-4", `${W}/personal/vibeguard.run-worktrees/vg-issue-4`),
    s("fmv-home-copy"),
    s("vg-umami"),
    s("drht-disk", `${W}/drawhatha-worktrees/drht-disk`),
    s("drht-ota"),
    s("dori-1", `${W}/dori-superagent`),
    s("board-web", `${W}/dori-superagent-worktrees/board-web`),
    s("board-links"),
    s("corpus-store", W, ["orangec-at/corpus"]),
    s("corpus-more"),
    s("dev-env"),
  ];
  const place = projectResolver(projectSeeds(home), new Map(), work);
  expect(Object.fromEntries(work.map((x) => [x.key, place(x)]))).toEqual({
    "vg-issue-4": "vibeguard",
    "fmv-home-copy": "vibeguard",
    "vg-umami": "vibeguard",
    "drht-disk": "drawhatha",
    "drht-ota": "drawhatha",
    "dori-1": "dori-superagent",
    "board-web": "dori-superagent",
    "board-links": "dori-superagent",
    "corpus-store": "corpus",
    "corpus-more": "corpus",
    "dev-env": "기타",
  });
});

test("folders of one family become one project: coupas-art joins coupas, dori-* joins the busiest dori-* project", () => {
  const work = [
    s("coupas-1", `${W}/personal/coupas`),
    s("cat-sand", `${W}/coupas-art/cat-sand`),
    s("cat-more"),
    s("dori-1", `${W}/dori-superagent`),
    s("dori-2", `${W}/dori-superagent-worktrees/dori-2`),
    s("biz-growth", `${W}/dori-research/biz-growth`),
    s("plan-v2", `${W}/dori-plans/plan-v2`),
    s("mr-1", `${W}/market-radar`),
    s("xmini-1", `${W}/personal/x-mini`),
    s("ops-access", `${W}/ops-access`),
  ];
  const place = projectResolver([], new Map(), work);
  expect(work.map(place)).toEqual([
    "coupas",
    "coupas",
    "coupas",
    "dori-superagent",
    "dori-superagent",
    "dori-superagent",
    "dori-superagent",
    "market-radar",
    "x-mini",
    "ops-access",
  ]);
});

test("~/.dori/projects.json alias moves a project or one lane/item key; a bad file or entry adds nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "dori-projects-alias-"));
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({ alias: { "ops-access": "dori-superagent", "Phone-Board": "dori-superagent", bad: 3, "": "x" } }),
  );
  const aliases = projectAliases(home);
  expect([...aliases]).toEqual([
    ["ops-access", "dori-superagent"],
    ["phone-board", "dori-superagent"],
  ]);
  const work = [s("ops-access", `${W}/ops-access`), s("phone-board"), s("dori-1", `${W}/dori-superagent`)];
  const place = projectResolver([], aliases, work);
  expect(work.map(place)).toEqual(["dori-superagent", "dori-superagent", "dori-superagent"]);
  writeFileSync(join(home, "projects.json"), "{nope");
  expect(projectAliases(home).size).toBe(0);
  expect(projectAliases(mkdtempSync(join(tmpdir(), "dori-projects-none-"))).size).toBe(0);
});

// The old fixed word list matched a backlog item's title; these are the items it placed that no key, cwd or PR does.
test("after title matching was removed, an item placed by nothing else still goes to the project its title names", () => {
  const item = (key: string, title: string, cwd = W): Subject => ({ ...s(key, cwd), title });
  const work = [
    s("vg-issue-4", `${W}/personal/vibeguard.run-worktrees/vg-issue-4`),
    s("coupas-1", `${W}/personal/coupas`),
    s("ab-2", `${W}/all-bots`),
    item("weekly-copy", "vibeguard 랜딩 문구 고치기"),
    item("sales-log", "Coupas 판매 로그 정리"),
    item("ab-p", "all-bots#10 Hermes Desktop dori 플러그인", `${W}/all-bots`),
    item("lunch", "점심 메뉴 정하기"),
  ];
  const place = projectResolver([], new Map(), work);
  expect(work.slice(3).map(place)).toEqual(["vibeguard", "coupas", "all-bots", "기타"]);
});

test("a malformed leads.json adds no seeds; the work still places itself", () => {
  const home = mkdtempSync(join(tmpdir(), "dori-projects-bad-"));
  writeFileSync(join(home, "leads.json"), "{not json");
  expect(projectSeeds(home)).toEqual([]);
});

const group = (name: string, over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  name,
  lanes: [],
  backlog: [],
  done: [],
  recent: [],
  at: 0,
  repos: [],
  bots: [],
  prefixes: [],
  milestones: [],
  note: null,
  links: [],
  purpose: null,
  asks: [],
  events: [],
  ...over,
});
const lane = (key: string) => ({
  key,
  status: "working" as const,
  at: 0,
  first: "",
  full: "",
  prs: [],
  escalated: false,
});

test("a channel belongs to the project named by its name, a prefix, a bot of it or its lanes' first word", () => {
  const projects = [
    group("vibeguard", { prefixes: ["fmv"], bots: ["endo"] }),
    group("dori-superagent", { recent: [lane("dori-12")] }),
    group("기타", { recent: [lane("with-x")] }),
  ];
  const bots = [{ name: "endo", label: "엔도" }] as never;
  expect(channelProject("fmv", { projects, bots })).toBe("vibeguard");
  expect(channelProject("엔도", { projects, bots })).toBe("vibeguard");
  expect(channelProject("dori", { projects, bots })).toBe("dori-superagent");
  expect(channelProject("with-bots", { projects, bots })).toBeNull();
  expect(messageProject("dori-superagent#31 병합했어요", projects)).toBe("dori-superagent");
  expect(messageProject("fmv 승인 스레드 확인", projects)).toBe("vibeguard");
  expect(messageProject("dori-12 끝", projects)).toBe("dori-superagent");
  expect(messageProject("점심 뭐 먹지", projects)).toBeNull();
});

test("a thread belongs to its parent channel's project unless a projects.json alias for its id names another", () => {
  const s = { projects: [group("vibeguard", { prefixes: ["fmv"] }), group("dori-superagent")], bots: [] };
  const chan = (key: string, name: string, more = {}) => ({
    key,
    name,
    kind: "thread" as const,
    messages: [],
    ...more,
  });
  const d = {
    channels: [
      { key: "c-fmv", name: "fmv", kind: "channel" as const, messages: [] },
      chan("t-a", "승인 스레드", { parent: "c-fmv" }),
      chan("t-b", "보드 작업", { parent: "c-fmv", project: "dori-superagent" }),
      chan("t-c", "fmv-lost"),
    ],
    syncedAt: null,
    error: null,
    skipped: [],
  };
  expect(d.channels.map((c) => chanProject(c, d, s))).toEqual([
    "vibeguard",
    "vibeguard",
    "dori-superagent",
    "vibeguard",
  ]);
});
