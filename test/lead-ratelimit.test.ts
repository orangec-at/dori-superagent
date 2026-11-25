import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooksSettled } from "../src/hooks.ts";
import { leadRateLimitTick, refusedMessages } from "../src/lead-ratelimit.ts";
import { setup } from "./harness-setup.ts";

const ERR =
  "The model provider could not complete the request after 0 retries (rate limited). Try again or choose another model with /model.";

function rig() {
  const s = setup();
  writeFileSync(
    join(s.d.store.root, "config.json"),
    JSON.stringify({ hooks: { onLeadRateLimited: ["fallback", "{text}", "{evidence}"] } }),
  );
  const ran: string[][] = [];
  s.w.reviewer = (argv) => {
    ran.push([...argv]);
    return { code: 0, stdout: "" };
  };
  return { ...s, ran };
}

describe("lead rate limit", () => {
  test("finds the chat messages answered with a rate-limit error, wrapped lines joined", () => {
    const screen = [
      "[Discord chat=1] answered fine",
      "Sure, done.",
      "[Slack chat=C1 thread=2 from=bk] a long message that the terminal",
      "   wrapped onto a second line",
      ERR,
      "  [Discord chat=1] 너 설마 또 멈췄나 ...  ",
      "",
      ERR,
      ERR,
    ].join("\n");
    expect(refusedMessages(screen)).toEqual([
      "[Slack chat=C1 thread=2 from=bk] a long message that the terminal wrapped onto a second line",
      "[Discord chat=1] 너 설마 또 멈췄나 ...",
    ]);
    expect(refusedMessages(`[Discord chat=1] hi\nok\n${"x\n".repeat(30)}${ERR}`)).toEqual([]);
  });

  test("the first pass only records the screen; each later refused message goes to the hook once", async () => {
    const { d, lead, ran } = rig();
    lead.screen = `[Discord chat=1] old one\n${ERR}\n`;
    expect(await leadRateLimitTick(d)).toEqual([]);
    expect(await leadRateLimitTick(d)).toEqual([]);

    lead.screen += `[Discord chat=1] are you there?\n${ERR}\n[Slack chat=C1 thread=2] ping\n${ERR}\n`;
    expect(await leadRateLimitTick(d)).toMatchObject([{ pane: "w1:p1", action: "lead-rate-limited" }]);
    await hooksSettled();
    expect(ran).toEqual([["[Discord chat=1] are you there?\n\n[Slack chat=C1 thread=2] ping", "w1:p1"]]);

    expect(await leadRateLimitTick(d)).toEqual([]);
    lead.screen = undefined;
    expect(await leadRateLimitTick(d)).toEqual([]);
    await hooksSettled();
    expect(ran).toHaveLength(1);
  });
});
