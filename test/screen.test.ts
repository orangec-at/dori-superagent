import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { send } from "../src/inbox.ts";
import { World, href } from "./fake.ts";

// Real omo screens captured with `herdr pane read --source recent`, sanitized (titles, costs, ids, paths replaced).
const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("delivery to a pane herdr calls working", () => {
  function setup(screenText?: string) {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "working");
    lead.screen = screenText;
    d.store.setRole("lead", href("w1:p1"));
    return { w, d, lead };
  }

  test("live monitors and an idle screen: the message is delivered", async () => {
    const { d, lead } = setup(await screen("omo-idle-live-monitors"));
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
  });

  test("a real turn: the message is queued and nothing is typed", async () => {
    const { w, d, lead } = setup(await screen("omo-turn"));
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[1] === "send-text" || c.argv[0] === "agent")).toBe(false);
  });

  test("a failed screen read keeps the message queued", async () => {
    const { d, lead } = setup(undefined);
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("blocked is never read as idle, whatever the screen shows", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"));
    lead.status = "blocked";
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(w.calls.some((c) => c.argv[1] === "read")).toBe(false);
  });

  test("unknown status and an idle screen: the message is delivered", async () => {
    const { d, lead } = setup(await screen("omo-idle-live-monitors"));
    lead.status = "unknown";
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
  });

  test("unknown status and a real turn: the message is queued", async () => {
    const { d, lead } = setup(await screen("omo-turn"));
    lead.status = "unknown";
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });
});

// #5: herdr reports no agent (shell) for an omo pane; `agent prompt` refuses it, so the text goes by send-text.
describe("delivery to an omo pane herdr sees no agent in", () => {
  function setup(screenText: string, foreground: string) {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "shell");
    lead.screen = screenText;
    lead.foreground = foreground;
    w.promptFails.set("w1:p1", "agent_not_ready");
    d.store.setRole("lead", href("w1:p1"));
    return { w, d, lead };
  }
  const typed = (w: World) => w.calls.some((c) => c.argv[1] === "send-text");

  test("omo in front and its idle screen: the message is typed and delivered", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"), "omo");
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
    expect(typed(w)).toBe(true);
  });

  test("a bare shell screen: the message is queued and nothing is typed", async () => {
    const { w, d, lead } = setup("$ ls\nREADME.md\n$ ", "omo");
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(typed(w)).toBe(false);
  });

  test("a shell in front is refused whatever the screen shows", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"), "-bash");
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(typed(w)).toBe(false);
  });
});
