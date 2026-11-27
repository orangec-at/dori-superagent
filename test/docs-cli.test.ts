import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { readDoc } from "../src/docs.ts";
import { Refusal } from "../src/refusal.ts";
import { setup } from "./harness-setup.ts";

const said: string[] = [];
const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void said.push(a.join(" ")));
afterEach(() => {
  said.length = 0;
});
afterAll(() => log.mockRestore());

test("dori doc add prints DOC <id> <link>, doc list prints one line per document, newest first", async () => {
  const { d } = setup();
  const home = d.store.root;
  const file = join(home, "plan.md");
  writeFileSync(file, "# 계획\n");
  const add = ["doc", "add", file, "--title", "보드 계획", "--project", "my proj", "--summary", "한 줄"];
  expect(await main([...add, "--id", "2026-11-27-plan"], d)).toBe(0);
  expect(said).toEqual(["DOC 2026-11-27-plan /?tab=docs&d=2026-11-27-plan"]);
  expect(readDoc(home, "2026-11-27-plan")).toMatchObject({ title: "보드 계획", project: "my proj", summary: "한 줄" });
  writeFileSync(join(home, "board.json"), JSON.stringify({ publicUrl: "https://board.example.ts.net:8446" }));
  said.length = 0;
  expect(await main(["doc", "add", file, "--title", "둘째"], d)).toBe(0);
  expect(said[0]).toMatch(/^DOC (\d{4}-\d{2}-\d{2}-plan) https:\/\/board\.example\.ts\.net:8446\/\?tab=docs&d=\1$/);
  said.length = 0;
  expect(await main(["doc", "list"], d)).toBe(0);
  expect(said).toHaveLength(2);
  expect(said.find((l) => l.startsWith("2026-11-27-plan "))).toMatch(/^2026-11-27-plan \S+ project=my_proj 보드 계획$/);
});

test("doc list with nothing prints NO_DOCS; a bad subcommand, a missing file or a missing --title is refused", async () => {
  const { d } = setup();
  expect(await main(["doc", "list"], d)).toBe(0);
  expect(said).toEqual(["NO_DOCS"]);
  const file = join(d.store.root, "a.md");
  writeFileSync(file, "x");
  await expect(main(["doc", "remove", file], d)).rejects.toThrow("unknown doc command remove");
  await expect(main(["doc", "add", join(d.store.root, "nope.md"), "--title", "t"], d)).rejects.toThrow("cannot read");
  await expect(main(["doc", "add", file], d)).rejects.toThrow(Refusal);
  await expect(main(["doc", "add", "--title", "t"], d)).rejects.toThrow("missing markdown file");
  await expect(main(["doc", "add", file, "--title", "t", "--id", "../x"], d)).rejects.toThrow("doc id must look like");
});
