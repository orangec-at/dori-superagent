import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLinks, saveLinks } from "../src/board-links-file.ts";
import { HOUR } from "../src/loop.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { setup } from "./loop-setup.ts";

const OMO = `"defaultProvider": "anthropic-subscription"\n"defaultModel": "claude-opus-5-5"\n`;

/** sh and ssh answer like a machine with omo; `hang` makes ssh never answer until it is killed. */
function machines(o: { hang?: boolean } = {}) {
  const killed: string[] = [];
  const exec =
    (inner: Exec): Exec =>
    async (cmd, argv, options) => {
      if (cmd === "sh") return { code: 0, stdout: OMO, stderr: "" };
      if (cmd !== "ssh") return inner(cmd, argv, options);
      if (!o.hang) return { code: 0, stdout: `  default: "gpt-6.1-sol"\n  provider: "openai-codex"\n`, stderr: "" };
      const host = argv[4]!;
      return new Promise((resolve) =>
        options?.onSpawn?.({
          kill: () => {
            killed.push(host);
            resolve({ code: 143, stdout: "", stderr: "terminated" });
          },
        }),
      );
    };
  return { killed, ...setup({ exec }) };
}

/** The saved map; a broken file fails the test here. */
const links = (home: string) => {
  const s = readLinks(home);
  if (s === "broken") throw new Error("board-links.json is broken");
  return s;
};
const laneIds = (home: string) => (links(home)?.actors ?? []).filter((a) => a.kind === "lane").map((a) => a.id);

describe("hourly loop: 연결 map refresh", () => {
  test("each run rewrites board-links.json, and a lane opened or closed shows on the next run", async () => {
    const { w, d, add, tick } = machines();
    const home = d.store.root;
    expect(readLinks(home)).toBeNull();

    add("links-one");
    const first = await tick();
    expect(first.started).toEqual(["links-one (p5)"]);
    expect(links(home)?.generatedAt).toBe(first.at);
    expect(links(home)?.actors.find((a) => a.id === "lead")).toMatchObject({ model: "claude-opus-5-5" });
    expect(laneIds(home)).toEqual(["lane:links-one"]);

    d.store.saveLane({ ...d.store.lane("links-one")!, status: "done" });
    add("links-two");
    w.clock += HOUR;
    const second = await tick();
    expect(links(home)?.generatedAt).toBe(second.at);
    expect(second.at).toBeGreaterThan(first.at);
    expect(laneIds(home)).toEqual(["lane:links-two"]);
    expect(second.findings.filter((f) => f.startsWith("links:"))).toEqual([]);
  });

  test("a machine that never answers is killed at the limit, the run goes on, and the last map is kept", async () => {
    const { d, tick, killed } = machines({ hang: true });
    const home = d.store.root;
    writeFileSync(
      join(home, "agents.json"),
      JSON.stringify([{ name: "panbungi", host: "ubuntu", profile: "panbungi", role: "sales", description: "판붕이" }]),
    );
    saveLinks(home, { generatedAt: 1, actors: [], unknown: [] });

    const run = await tick({ linksTimeoutMs: 50 });
    expect(run.findings).toContain("links: 연결도 갱신 시간 초과 (1초), 지난 연결도를 그대로 둠");
    // The bot's profile and the machine's hermes profiles: both reads hang and both are killed.
    expect(killed).toEqual(["ubuntu", "ubuntu"]);
    expect(links(home)?.generatedAt).toBe(1);
    expect(d.store.lastRun()!.at).toBe(run.at);
  });
});
