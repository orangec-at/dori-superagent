import { costText, limitFor, loadBudgets, setBudget } from "./budget.ts";
import { type Args, need, one, USAGE } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";

export function runBudget(d: Deps, a: Args, x: string | undefined): number {
  if (x === "set") {
    const target = need(a.pos[2], "lane key or default");
    const usd = Number(need(one(a, "usd"), "--usd"));
    setBudget(d.store.root, target, usd);
    console.log(`BUDGET ${target} $${usd}`);
    return 0;
  }
  if (x !== "show") throw new Refusal(`usage: dori budget set <lane|default> --usd N | dori budget show\n\n${USAGE}`);
  const b = loadBudgets(d.store.root);
  console.log(`BUDGET default ${b.default === undefined ? "-" : `$${b.default}`}`);
  for (const [key, usd] of Object.entries(b.lanes)) console.log(`BUDGET ${key} $${usd}`);
  for (const l of d.store.lanes()) {
    if (l.status === "done") continue;
    const at = l.costAt === undefined ? "" : `  read ${new Date(l.costAt).toISOString()}`;
    console.log(`${l.key.padEnd(24)} ${costText(l, limitFor(b, l.key))}${at}`);
  }
  return 0;
}
