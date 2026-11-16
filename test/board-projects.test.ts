import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectResolver, projectSeeds, repoOfCwd, type Subject } from "../src/board-projects.ts";
import { channelProject, messageProject } from "../src/board-projects-html.ts";
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
  const place = projectResolver(projectSeeds(home), work);
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
  note: null,
  links: [],
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
