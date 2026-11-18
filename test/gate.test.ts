import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("merge.allowNoChecks lets a listed repo merge with no checks at all, pinned to a CLEAR head; nothing else changes", async () => {
    const { w, d } = setup();
    const config = (merge: unknown) => writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ merge }));
    const noChecks = () => {
      gh(w, []);
      const base = w.gh;
      w.gh = (argv) =>
        argv[1] === "checks" ? { code: 1, stdout: "", stderr: "no checks reported on the 'feat' branch" } : base(argv);
    };
    noChecks();
    config({ allowNoChecks: ["o/r"] });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    d.store.saveReceipt({ pr: "o/r#7", sha: "b".repeat(40), verdict: "CLEAR", model: "m", at: d.now(), summary: "" });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt at head");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#7");
    expect(await mergeGate(d, "o/r#7", { dryRun: true })).toBe(
      `MERGE_OK o/r#7 head=${head} (dry run) (no checks: allowed by config merge.allowNoChecks)`,
    );
    expect(await mergeGate(d, "o/r#7")).toBe(
      `MERGED o/r#7 head=${head} (no checks: allowed by config merge.allowNoChecks)`,
    );
    expect(w.calls.at(-1)!.argv).toEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "o/r",
      "--squash",
      "--match-head-commit",
      head,
    ]);
    gh(w, [{ name: "test", bucket: "fail" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    w.gh = (argv) =>
      argv[1] === "view"
        ? { code: 0, stdout: JSON.stringify({ headRefOid: head }) }
        : { code: 1, stdout: "", stderr: "HTTP 502" };
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    noChecks();
    config({ allowNoChecks: ["o/other"] });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    config({});
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    config({ allowNoChecks: "o/r" });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("merge.allowNoChecks must be an array of strings");
    config({ allowNoChecks: ["o/r", 3] });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("merge.allowNoChecks must be an array of strings");
    config(["o/r"]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("merge must be an object");
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });
});
