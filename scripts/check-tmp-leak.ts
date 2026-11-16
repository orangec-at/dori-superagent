/**
 * The temp-dir leak gate: runs both test suites with TMPDIR set to one fresh, empty directory and fails if anything is
 * left in it afterwards. It also counts this user's dori-* entries in the real tmpdir before and after, for the record.
 *
 * Prints `TMP_LEAK_OK before=<n> after=<n>` and exits 0, `TMP_LEAK <name>` per leftover and exits 1, or exits with the
 * failing suite's code.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SUITES = [
  { cwd: root, cmd: ["bun", "test", "./test/"] },
  { cwd: join(root, "skills/dori-mode/scripts"), cmd: ["bun", "test"] },
] as const;

const countDori = (dir: string): number =>
  readdirSync(dir).filter((n) => {
    if (!n.startsWith("dori-")) return false;
    try {
      return statSync(join(dir, n)).uid === process.getuid?.();
    } catch {
      return false;
    }
  }).length;

const realTmp = tmpdir();
const before = countDori(realTmp);
const box = mkdtempSync(join(realTmp, "dori-leakcheck-"));
let code = 0;
for (const s of SUITES) {
  const p = Bun.spawn([...s.cmd], {
    cwd: s.cwd,
    env: { ...process.env, TMPDIR: box },
    stdio: ["ignore", "inherit", "inherit"],
  });
  code ||= await p.exited;
}
const leftovers = readdirSync(box);
rmSync(box, { recursive: true, force: true });
const after = countDori(realTmp);
for (const n of leftovers) console.log(`TMP_LEAK ${n}`);
if (code) process.exit(code);
if (leftovers.length) process.exit(1);
console.log(`TMP_LEAK_OK before=${before} after=${after}`);
