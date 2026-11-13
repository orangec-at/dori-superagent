import { expect, test } from "bun:test";
import { askAdd, askClose, asks, markSent, parseOptions, readAsk } from "../src/asks.ts";
import { main } from "../src/cli.ts";
import { Refusal } from "../src/refusal.ts";
import { setup } from "./harness-setup.ts";

const NOW = Date.UTC(2026, 10, 13, 1, 0, 0);

test("dori ask registers a decision, ask list shows it, ask close takes it off", async () => {
  const { d } = setup();
  const code = await main(
    [
      "ask",
      "vg-analytics",
      "--question",
      "vibeguard 분석 도구는?",
      "--option",
      "A=Umami Cloud 무료",
      "--option",
      "B=Plausible $9",
      "--recommend",
      "A",
      "--link",
      "https://github.com/o/r/issues/1",
    ],
    d,
  );
  expect(code).toBe(0);
  expect(readAsk(d.store.root, "vg-analytics")).toMatchObject({
    id: "vg-analytics",
    question: "vibeguard 분석 도구는?",
    options: [
      { key: "A", text: "Umami Cloud 무료" },
      { key: "B", text: "Plausible $9" },
    ],
    recommend: "A",
    link: "https://github.com/o/r/issues/1",
    status: "open",
  });
  expect(await main(["ask", "list"], d)).toBe(0);
  expect(await main(["ask", "close", "vg-analytics"], d)).toBe(0);
  expect(readAsk(d.store.root, "vg-analytics")?.status).toBe("closed");
  expect(asks(d.store.root).filter((a) => a.status === "open")).toEqual([]);
});

test("an ask is refused when its id, question, options, recommendation or link is bad", () => {
  const { d } = setup();
  const home = d.store.root;
  const options = parseOptions(["A=yes", "B=no"]);
  const add = (id: string, over: Partial<Parameters<typeof askAdd>[2]> = {}) =>
    askAdd(home, id, { question: "ship?", options, now: NOW, ...over });
  expect(() => add("Bad Id")).toThrow(Refusal);
  expect(() => add("close")).toThrow("subcommand");
  expect(() => add("ok-id", { question: " " })).toThrow("--question");
  expect(() => add("ok-id", { question: "x".repeat(501) })).toThrow("--question");
  expect(() => add("ok-id", { recommend: "C" })).toThrow("not one of the options");
  expect(() => add("ok-id", { link: "javascript:alert(1)" })).toThrow("--link");
  expect(() => parseOptions([])).toThrow("--option");
  expect(() => parseOptions(["yes"])).toThrow("KEY=text");
  expect(() => parseOptions(["a=lower"])).toThrow("KEY=text");
  expect(() => parseOptions(["A=x", "A=y"])).toThrow("unique");
  expect(() => parseOptions(["A="])).toThrow("characters");
  expect(asks(home)).toEqual([]);
});

test("markSent records the board's answer only for an open ask and one of its options; re-asking clears it", () => {
  const { d } = setup();
  const home = d.store.root;
  const options = parseOptions(["A=yes", "B=no"]);
  askAdd(home, "q-one", { question: "ship?", options, recommend: "A", now: NOW });
  expect(() => markSent(home, "q-one", "C", NOW)).toThrow("not an option");
  expect(() => markSent(home, "q-two", "A", NOW)).toThrow("no open ask");
  expect(markSent(home, "q-one", "B", NOW + 1).sent).toEqual({ choice: "B", at: NOW + 1 });
  askAdd(home, "q-one", { question: "ship now?", options, now: NOW + 2 });
  expect(readAsk(home, "q-one")?.sent).toBeUndefined();
  askClose(home, "q-one", NOW + 3);
  expect(() => markSent(home, "q-one", "A", NOW + 4)).toThrow("no open ask");
  expect(() => askClose(home, "q-none", NOW)).toThrow("no ask");
});
