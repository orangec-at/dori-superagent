import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { flushInbox, send } from "../src/inbox.ts";
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

  test("every Enter failed: the next flush presses only Enter, though the typed text hides the idle input", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"), "omo");
    w.keyFails = 3;
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    lead.screen = await screen("omo-draft");
    const before = w.calls.length;
    expect(await flushInbox(d, href("w1:p1"))).toBe("delivered");
    const after = w.calls.slice(before).map((c) => c.argv.slice(0, 2).join(" "));
    expect(after).toContain("pane send-keys");
    expect(after).not.toContain("pane send-text");
    expect(lead.received).toEqual(["hello"]);
    expect(d.store.queued(href("w1:p1"))).toEqual([]);
  });

  test("every Enter failed and the foreground changed: the typed text is held, no Enter", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"), "omo");
    w.keyFails = 3;
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    lead.screen = await screen("omo-draft");
    lead.pgid = 202;
    const before = w.calls.length;
    expect(await flushInbox(d, href("w1:p1"))).toBe("held");
    expect(w.calls.slice(before).some((c) => c.argv[1] === "send-keys")).toBe(false);
  });

  test("a shell in front is refused whatever the screen shows", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"), "-bash");
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(typed(w)).toBe(false);
  });
});
