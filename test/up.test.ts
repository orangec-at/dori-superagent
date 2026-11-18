import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { leadCommand, status, up } from "../src/cli-up.ts";
import { refText } from "../src/refs.ts";
import { groupId } from "../src/runtime/group.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("dori up", () => {
  test("herdr: the same 8 calls as before runtimes existed, and all four roles registered", async () => {
    const w = new World();
    const d = w.deps();
    const root = d.store.root;
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const prompt = (name: string) => `omo --append-system-prompt '${join(root, "prompts", name)}'`;
    const split = (near: string, ...env: string[]) => [
      "pane",
      "split",
      near,
      "--direction",
      "down",
      "--ratio",
      "0.3",
      "--cwd",
      "/w",
      "--no-focus",
      ...env.flatMap((e) => ["--env", e]),
    ];
    expect(w.calls.map((c) => [c.cmd, ...c.argv])).toEqual(
      [
        ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
        ["pane", "run", "w1:p2", prompt("lead.md")],
        [
          "tab",
          "create",
          "--label",
          "duty",
          "--cwd",
          "/w",
          "--no-focus",
          "--workspace",
          "w1",
          "--env",
          `DORI_HOME=${root}`,
        ],
        ["pane", "run", "w1:p3", prompt("duty.md")],
        split("w1:p3", `DORI_HOME=${root}`),
        ["pane", "run", "w1:p4", "dori duty --interval 60"],
        split("w1:p4", `DORI_HOME=${root}`, "HERDR_WORKSPACE_ID=w1"),
        ["pane", "run", "w1:p5", "dori loop"],
      ].map((argv) => ["herdr", ...argv]),
    );
    expect(JSON.parse(readFileSync(join(root, "roles.json"), "utf8"))).toEqual({
      lead: "w1:p2",
      duty: "w1:p3",
      "duty-loop": "w1:p4",
      "hourly-loop": "w1:p5",
    });
    expect(out).toBe(`UP runtime=herdr lead=w1:p2 duty=w1:p3 loop=w1:p4 hourly=w1:p5 home=${root}`);
    const shown = await captureIo(async () => {
      status(d);
      return 0;
    });
    expect(shown.out.split("\n")[1]).toBe(`lead=w1:p2 duty=w1:p3 loop=w1:p4 hourly=w1:p5 home=${root}`);
    expect(shown.out).not.toContain("ROLES not registered");
  });

  test("status names the loop panes, and says so when a home from before #155 never registered them", async () => {
    const w = new World();
    const d = w.deps();
    writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w3:p1", duty: "w3:p2" }));
    const { out } = await captureIo(async () => {
      status(d);
      return 0;
    });
    const lines = out.split("\n");
    expect(lines[1]).toBe(`lead=w3:p1 duty=w3:p2 loop=- hourly=- home=${d.store.root}`);
    expect(lines[2]).toBe("ROLES not registered: duty-loop, hourly-loop (dori role <role> <pane>)");
  });

  test("dori role registers the loop panes status asks for, and still refuses a role it does not know", async () => {
    const w = new World();
    const d = w.deps();
    writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w3:p1", duty: "w3:p2" }));
    await captureIo(async () => {
      expect(await main(["role", "duty-loop", "w3:p3"], d)).toBe(0);
      expect(await main(["role", "hourly-loop", "w3:p4"], d)).toBe(0);
      await expect(main(["role", "lane", "w3:p5"], d)).rejects.toThrow(
        "role must be one of lead, duty, duty-loop, hourly-loop",
      );
      return 0;
    });
    expect(refText(d.store.roles()["duty-loop"]!)).toBe("w3:p3");
    expect(refText(d.store.roles()["hourly-loop"]!)).toBe("w3:p4");
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({
      lead: "w3:p1",
      duty: "w3:p2",
      "duty-loop": "w3:p3",
      "hourly-loop": "w3:p4",
    });
    const { out } = await captureIo(async () => {
      status(d);
      return 0;
    });
    expect(out.split("\n")[1]).toBe(`lead=w3:p1 duty=w3:p2 loop=w3:p3 hourly=w3:p4 home=${d.store.root}`);
    expect(out).not.toContain("ROLES not registered");
  });

  test("leadModel in config.json adds --model to the lead command only; a non-string is refused", async () => {
    const w = new World();
    const d = w.deps();
    const root = d.store.root;
    writeFileSync(join(root, "config.json"), JSON.stringify({ leadModel: "anthropic-subscription/claude-fable-5-2" }));
    await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const runs = w.calls.filter((c) => c.argv[0] === "pane" && c.argv[1] === "run").map((c) => c.argv[3]);
    expect(runs).toEqual([
      `omo --model 'anthropic-subscription/claude-fable-5-2' --append-system-prompt '${join(root, "prompts", "lead.md")}'`,
      `omo --append-system-prompt '${join(root, "prompts", "duty.md")}'`,
      "dori duty --interval 60",
      "dori loop",
    ]);
    for (const bad of [5, "", "  "]) {
      writeFileSync(join(root, "config.json"), JSON.stringify({ leadModel: bad }));
      expect(() => leadCommand(d)).toThrow("leadModel must be a non-empty string");
    }
    writeFileSync(join(root, "config.json"), JSON.stringify({ leadModel: " a/b " }));
    expect(leadCommand(d)).toStartWith("omo --model 'a/b' --append-system-prompt ");
  });

  test("hc: four terminals in this home's group, prefixed roles, no herdr workspace variable", async () => {
    const w = new World();
    const d = w.deps({ runtime: "hc" });
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const runs = w.calls.filter((c) => c.cmd === "hc" && c.argv[1] === "run").map((c) => c.argv);
    expect(runs).toHaveLength(4);
    for (const argv of runs) expect(argv).toContain(`dori.group=${groupId(d.store.root)}`);
    expect(runs.map((a) => a.find((x) => x.startsWith("dori.role=")))).toEqual([
      "dori.role=lead",
      "dori.role=duty",
      "dori.role=duty-loop",
      "dori.role=hourly-loop",
    ]);
    expect(runs.some((a) => a.some((x) => x.startsWith("HERDR_WORKSPACE_ID=")))).toBe(false);
    expect(w.calls.some((c) => c.cmd === "herdr")).toBe(false);
    expect(w.hc.calls.filter((c) => c[0] === "send").map((c) => c.at(-1))).toEqual([
      expect.stringContaining("lead.md"),
      expect.stringContaining("duty.md"),
      "dori duty --interval 60",
      "dori loop",
    ]);
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({
      lead: "hc:t1",
      duty: "hc:t2",
      "duty-loop": "hc:t3",
      "hourly-loop": "hc:t4",
    });
    expect(out).toStartWith("UP runtime=hc lead=hc:t1 duty=hc:t2 loop=hc:t3 hourly=hc:t4 ");
  });
});
