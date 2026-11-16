import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStanding } from "../src/cli-lead.ts";
import type { LoopRun } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

export const LEADS = [
  {
    domain: "vibeguard",
    keyPrefixes: ["vg-"],
    repos: ["vibeguard-run/web"],
    bots: ["endo"],
    rules: ["Never merge a site PR before makun approves it."],
  },
];

export function world(opts: { leads?: unknown } = {}) {
  const s = setup();
  writeFileSync(
    join(s.d.store.root, "leads.json"),
    typeof opts.leads === "string" ? opts.leads : JSON.stringify(opts.leads ?? LEADS),
  );
  const on = async () => {
    const state = await startStanding(s.d, "vibeguard", { group: "w1" });
    const pane = s.w.panes.get(state.sessionRef.id)!;
    pane.status = "idle";
    return { state, pane };
  };
  return { ...s, on };
}

export const emptyRun = (at: number): LoopRun => ({ at, synced: [], findings: [], started: [], held: [], asked: [] });

export async function cli(
  run: (argv: string[]) => Promise<number>,
  argv: string[],
): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (line: string) => out.push(line);
  try {
    return { code: await run(argv), out };
  } finally {
    console.log = log;
  }
}
