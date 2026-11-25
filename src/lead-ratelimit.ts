// The lead's model provider refusing its turns (a rate or usage limit): messages reach the lead and get no answer.
// The lead looks idle and its inbox empties, so nothing else in the duty pass notices; the screen is the only trace.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";

/** How much of the lead's screen is searched for refused messages. */
export const RATE_LIMIT_SCREEN_LINES = 150;
/** How many answered-or-reported message hashes are kept, so one message is reported once. */
const KEEP = 200;
/** How far above an error line a wrapped message may start. */
const WRAP_LINES = 20;

const LIMITED = /could not complete the request.*rate limited/i;
const INCOMING = /^\[(Discord|Slack) chat=/;

/**
 * The chat messages on the screen that the agent answered with a rate-limit error: for each error line, the closest
 * `[Discord chat=…]` / `[Slack chat=…]` line above it, joined with the lines it wrapped onto.
 */
export function refusedMessages(screen: string): string[] {
  const lines = screen
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!LIMITED.test(line)) return;
    for (let j = i - 1; j >= 0 && j >= i - WRAP_LINES; j--) {
      const above = lines[j] ?? "";
      if (LIMITED.test(above)) return;
      if (INCOMING.test(above)) {
        out.push(lines.slice(j, i).join(" "));
        return;
      }
    }
  });
  return out;
}

type State = { readonly seen: readonly string[] };
const statePath = (root: string): string => join(root, "lead", "ratelimit.json");
const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function readState(root: string): State | undefined {
  const path = statePath(root);
  if (!existsSync(path)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const seen: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "seen") : undefined;
  return { seen: Array.isArray(seen) ? seen.filter((s): s is string => typeof s === "string") : [] };
}

function writeState(root: string, seen: readonly string[]): void {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ seen: seen.slice(-KEEP) })}\n`);
}

/**
 * One duty pass over the lead's screen: chat messages it refused with a rate-limit error and that were not reported
 * yet go to hooks.onLeadRateLimited once, as `{text}` (one message per paragraph), so a fallback can answer them. The
 * first pass only records what is already on the screen: a duty loop that starts late does not answer old messages.
 */
export async function leadRateLimitTick(d: Deps): Promise<DutyEvent[]> {
  const lead = d.store.roles().lead;
  if (lead === undefined) return [];
  let screen: string;
  try {
    screen = await d.runtimes.for(lead).read(lead, RATE_LIMIT_SCREEN_LINES);
  } catch {
    return [];
  }
  const root = d.store.root;
  const state = readState(root);
  const refused = refusedMessages(screen).map((text) => ({ text, id: hash(text) }));
  const fresh = state === undefined ? [] : refused.filter((m) => !state.seen.includes(m.id));
  if (state !== undefined && fresh.length === 0) return [];
  writeState(root, [...(state?.seen ?? []), ...refused.map((m) => m.id).filter((id) => !state?.seen.includes(id))]);
  if (fresh.length === 0) return [];
  const pane = refText(lead);
  void runHook(d, "onLeadRateLimited", { key: "lead", text: fresh.map((m) => m.text).join("\n\n"), evidence: pane });
  return [{ pane, action: "lead-rate-limited", detail: `${fresh.length} message(s) refused by the model provider` }];
}
