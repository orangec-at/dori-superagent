import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import type { Runner } from "../src/self-update.ts";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

export async function sh(cwd: string, cmd: string, ...argv: string[]): Promise<string> {
  const r = await spawnExec(cmd, cmd === "git" ? [...ID, ...argv] : argv, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export const runnerIn =
  (cwd: string): Runner =>
  (cmd, argv) =>
    spawnExec(cmd, argv, { cwd });

/** A bare origin with one commit on main, the dori checkout cloned from it, and a second clone that pushes. */
export async function gitWorld(): Promise<{
  checkout: string;
  pusher: string;
  push: (file: string) => Promise<string>;
}> {
  const root = mkdtempSync(join(tmpdir(), "dori-selfupdate-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await sh(root, "git", "init", "--quiet", "--bare", "--initial-branch=main", origin);
  mkdirSync(join(seed, "prompts"), { recursive: true });
  await sh(root, "git", "init", "--quiet", "--initial-branch=main", seed);
  writeFileSync(join(seed, "prompts", "lead.md"), "You are the lead.\n- rule one\n");
  await sh(seed, "git", "add", ".");
  await sh(seed, "git", "commit", "--quiet", "-m", "seed");
  await sh(seed, "git", "remote", "add", "origin", origin);
  await sh(seed, "git", "push", "--quiet", "origin", "main");
  const checkout = join(root, "checkout");
  const pusher = join(root, "pusher");
  await sh(root, "git", "clone", "--quiet", origin, checkout);
  await sh(root, "git", "clone", "--quiet", origin, pusher);
  const push = async (file: string): Promise<string> => {
    writeFileSync(join(pusher, file), `${file} ${Math.random()}\n`);
    await sh(pusher, "git", "add", ".");
    await sh(pusher, "git", "commit", "--quiet", "-m", `add ${file}`);
    await sh(pusher, "git", "push", "--quiet", "origin", "main");
    return sh(pusher, "git", "rev-parse", "HEAD");
  };
  return { checkout, pusher, push };
}
