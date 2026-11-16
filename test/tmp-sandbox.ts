/**
 * Test preload (bunfig.toml): every `bun test` run gets one private TMPDIR, removed when the run ends. Tests, and the
 * processes they spawn, take their temp dirs from os.tmpdir(), so everything they create goes with the sandbox.
 * A run that was killed leaves its sandbox behind; the next run sweeps this user's test leftovers older than an hour.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStale } from "./tmp-sweep.ts";

const base = tmpdir();
sweepStale(base, process.getuid?.());
const sandbox = mkdtempSync(join(base, "dori-run-"));
process.env["TMPDIR"] = sandbox;
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
