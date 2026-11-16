/**
 * Test preload (bunfig.toml), the skill's copy of test/tmp-sandbox.ts: every `bun test` run gets one private TMPDIR,
 * removed when the run ends, and this user's dori-test-* / dori-run-* dirs left by killed runs over an hour old are swept.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = tmpdir();
const uid = process.getuid?.();
for (const name of readdirSync(base)) {
  if (uid === undefined || !/^dori-(run|test)-/.test(name)) continue;
  try {
    const st = statSync(join(base, name));
    if (st.isDirectory() && st.uid === uid && Date.now() - st.mtimeMs >= 60 * 60 * 1000) {
      rmSync(join(base, name), { recursive: true, force: true });
    }
  } catch {
    // Swept by a concurrent run already.
  }
}
const sandbox = mkdtempSync(join(base, "dori-run-"));
process.env["TMPDIR"] = sandbox;
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
