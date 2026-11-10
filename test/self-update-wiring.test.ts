import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePrompts } from "../src/cli-self-update.ts";
import { overlayPath, prompt, promptText } from "../src/harness.ts";
import { autoSelfUpdate, loadSelfUpdateConfig, restartTargets } from "../src/self-update-run.ts";
import { fetchEnv } from "../src/self-update.ts";
import { World } from "./fake.ts";
import { gitWorld, runnerIn, sh } from "./self-update-git.ts";

afterEach(() => {
  delete process.env["DORI_PROMPTS_DIR"];
  delete process.env["DORI_SELF_UPDATE"];
});

function promptsIn(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dori-prompts-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  process.env["DORI_PROMPTS_DIR"] = dir;
  return dir;
}

describe("prompt overlays", () => {
  test("the overlay is appended after one blank line and its {{vars}} are filled too", () => {
    promptsIn({ "lane-footer.md": "Lane {{key}}.\n" });
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    expect(prompt("lane-footer.md", { key: "k1" }, home)).toBe("Lane k1.\n");
    mkdirSync(join(home, "prompts", "overlay"), { recursive: true });
    writeFileSync(overlayPath(home, "lane-footer.md"), "\n## Machine rules\n9. {{key}} works in a worktree.\n");
    expect(prompt("lane-footer.md", { key: "k1" }, home)).toBe(
      "Lane k1.\n\n## Machine rules\n9. k1 works in a worktree.\n",
    );
  });

  test("an overlay without a blank first line gets one, and keeps its indentation", () => {
    promptsIn({ "lead.md": "Lead.\n" });
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    mkdirSync(join(home, "prompts", "overlay"), { recursive: true });
    writeFileSync(overlayPath(home, "lead.md"), "    indented rule");
    expect(promptText("lead.md", home)).toBe("Lead.\n\n    indented rule\n");
  });

  test("no home, or an empty overlay, gives the repo prompt unchanged", () => {
    promptsIn({ "lead.md": "Lead.\n" });
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    mkdirSync(join(home, "prompts", "overlay"), { recursive: true });
    writeFileSync(overlayPath(home, "lead.md"), "  \n");
    expect(promptText("lead.md", undefined)).toBe("Lead.\n");
    expect(promptText("lead.md", home)).toBe("Lead.\n");
  });
});

describe("dori self-update --migrate-prompts", () => {
  test("local additions move to the overlay, the checkout is clean, and the merged prompt is what the edit was", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    const file = join(g.checkout, "prompts", "lead.md");
    appendFileSync(file, "\n## Machine rules (this host)\n\n- use worktrees\n");
    const edited = readFileSync(file, "utf8");
    const lines = await migratePrompts(runnerIn(g.checkout), home);
    expect(lines).toEqual([
      `MIGRATED prompts/lead.md -> ${overlayPath(home, "lead.md")} (4 lines appended after the repo prompt)`,
    ]);
    expect(await sh(g.checkout, "git", "status", "--porcelain")).toBe("");
    expect(existsSync(`${overlayPath(home, "lead.md")}.local.patch`)).toBe(true);
    process.env["DORI_PROMPTS_DIR"] = join(g.checkout, "prompts");
    expect(promptText("lead.md", home)).toBe(edited);
    expect(await migratePrompts(runnerIn(g.checkout), home)).toEqual([
      "NOTHING_TO_MIGRATE prompts/ has no local changes",
    ]);
  });

  test("a change that removes lines is left in place for a person", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    writeFileSync(join(g.checkout, "prompts", "lead.md"), "You are the lead.\n");
    const [line] = await migratePrompts(runnerIn(g.checkout), home);
    expect(line).toStartWith("SKIP prompts/lead.md: the local change is not a plain addition at the end");
    expect(await sh(g.checkout, "git", "diff", "--name-only")).toBe("prompts/lead.md");
    expect(existsSync(overlayPath(home, "lead.md"))).toBe(false);
  });

  test("a line inserted mid-file is left in place: an overlay could only come back at the end", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    const file = join(g.checkout, "prompts", "lead.md");
    writeFileSync(file, "You are the lead.\n- inserted rule\n- rule one\n");
    const [line] = await migratePrompts(runnerIn(g.checkout), home);
    expect(line).toStartWith("SKIP prompts/lead.md: the local change is not a plain addition at the end");
    expect(readFileSync(file, "utf8")).toBe("You are the lead.\n- inserted rule\n- rule one\n");
    expect(existsSync(overlayPath(home, "lead.md"))).toBe(false);
  });

  test("removing a --- rule is a removal, not an addition, even though its diff line starts with ---", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    const file = join(g.checkout, "prompts", "lead.md");
    writeFileSync(file, "You are the lead.\n---\n- rule one\n");
    await sh(g.checkout, "git", "commit", "--quiet", "-am", "add a rule line");
    writeFileSync(file, "You are the lead.\n- rule one\n- added rule\n");
    const [line] = await migratePrompts(runnerIn(g.checkout), home);
    expect(line).toStartWith("SKIP prompts/lead.md: the local change is not a plain addition at the end");
    expect(existsSync(overlayPath(home, "lead.md"))).toBe(false);
  });

  test("a nested prompt is skipped: overlays are keyed by file name, so two nested files would share one", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    mkdirSync(join(g.checkout, "prompts", "sub"), { recursive: true });
    writeFileSync(join(g.checkout, "prompts", "sub", "lead.md"), "nested\n");
    await sh(g.checkout, "git", "add", ".");
    await sh(g.checkout, "git", "commit", "--quiet", "-m", "nested prompt");
    appendFileSync(join(g.checkout, "prompts", "sub", "lead.md"), "- added\n");
    const [line] = await migratePrompts(runnerIn(g.checkout), home);
    expect(line).toStartWith("SKIP prompts/sub/lead.md: only top-level prompts/*.md have overlays");
    expect(existsSync(overlayPath(home, "lead.md"))).toBe(false);
  });

  test("an added line starting with + keeps its character", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    appendFileSync(join(g.checkout, "prompts", "lead.md"), "\n++ keep both pluses\n");
    await migratePrompts(runnerIn(g.checkout), home);
    expect(readFileSync(overlayPath(home, "lead.md"), "utf8")).toBe("\n++ keep both pluses\n");
  });

  test("an append without a blank first line is left in place: as an overlay it would gain one", async () => {
    const g = await gitWorld();
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    const file = join(g.checkout, "prompts", "lead.md");
    appendFileSync(file, "- glued rule\n");
    const edited = readFileSync(file, "utf8");
    const [line] = await migratePrompts(runnerIn(g.checkout), home);
    expect(line).toStartWith("SKIP prompts/lead.md: as an overlay the local change would not render byte for byte");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(existsSync(overlayPath(home, "lead.md"))).toBe(false);
  });
});

describe("selfUpdate config and the automatic trigger", () => {
  test("the fetch never prompts, and leaves a repo's own core.sshCommand or GIT_SSH_COMMAND alone", () => {
    expect(fetchEnv(false, { PATH: "/bin" })).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=30",
    });
    expect(fetchEnv(true, { PATH: "/bin" })["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(fetchEnv(false, { GIT_SSH_COMMAND: "ssh -i deploy" })["GIT_SSH_COMMAND"]).toBe("ssh -i deploy");
  });

  test("config: services come before the two loop roles; auto off by config or DORI_SELF_UPDATE=off", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-home-"));
    expect(loadSelfUpdateConfig(home)).toMatchObject({ auto: true, services: [] });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ selfUpdate: { services: ["dori-serve"], notify: "discord:1" } }),
    );
    const c = loadSelfUpdateConfig(home);
    expect(restartTargets(c).map((t) => t.name)).toEqual(["dori-serve", "duty-loop", "hourly-loop"]);
    process.env["DORI_SELF_UPDATE"] = "off";
    expect(loadSelfUpdateConfig(home).auto).toBe(false);
    writeFileSync(join(home, "config.json"), JSON.stringify({ selfUpdate: { services: "dori-serve" } }));
    expect(() => loadSelfUpdateConfig(home)).toThrow("selfUpdate.services must be an array of strings");
  });

  test("the trigger starts a background run unless auto is off or the loop is stopped, and fetches nothing", () => {
    const w = new World();
    const d = w.deps();
    let started = 0;
    const start = () => void started++;
    expect(autoSelfUpdate(d, start)).toStartWith("SELF_UPDATE_STARTED");
    d.store.setStop(d.now(), "maintenance");
    expect(autoSelfUpdate(d, start)).toContain("the loop is stopped (maintenance)");
    d.store.clearStop();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ selfUpdate: { auto: false } }));
    expect(autoSelfUpdate(d, start)).toStartWith("SELF_UPDATE_OFF");
    expect(started).toBe(1);
    expect(w.calls.filter((c) => c.cmd === "git")).toEqual([]);
  });
});
