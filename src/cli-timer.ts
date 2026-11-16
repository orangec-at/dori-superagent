import { need, one, textOf, USAGE, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { addTimer, cancelTimer, loadTimers, parseAt, parseEvery, timerLine } from "./timers.ts";

export async function runTimer(d: Deps, a: Args, x: string | undefined): Promise<number> {
  if (x === "add") {
    const id = need(a.pos[2], "timer id");
    const at = parseAt(need(one(a, "at"), "--at"), d.now());
    const every = one(a, "every");
    const t = addTimer(d, id, at, await textOf(a), every === undefined ? undefined : parseEvery(every));
    console.log(`TIMER_ADDED ${t.id} at=${new Date(t.at).toISOString()}${every ? ` every=${every}` : ""}`);
  } else if (x === "list" || x === undefined) {
    const timers = loadTimers(d.store.root).filter((t) => one(a, "all") === "true" || t.status === "pending");
    if (timers.length === 0) console.log("NO_TIMERS");
    for (const t of timers) console.log(timerLine(t));
  } else if (x === "cancel") {
    const id = need(a.pos[2], "timer id");
    cancelTimer(d, id);
    console.log(`TIMER_CANCELLED ${id}`);
  } else {
    throw new Refusal(`unknown timer command ${x}\n\n${USAGE}`);
  }
  return 0;
}
