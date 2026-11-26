// The lead's model provider refusing its turns (a rate or usage limit): messages reach the lead and get no answer.
// The lead looks idle and its inbox empties, so nothing else in the duty pass notices; the screen is the only trace.
// The screen only says that a delivered batch was refused. Which chat it came from and what it said are taken from the
// inbox's record of what it delivered (lead-delivered.ts): a chat message can put any header or error text on the screen.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { type Delivered, deliveredToLead, writeAtomic } from "./lead-delivered.ts";
import { refText } from "./refs.ts";
import type { AgentStatus } from "./runtime/types.ts";

/** How much of the lead's screen is searched for refused messages. */
export const RATE_LIMIT_SCREEN_LINES = 150;
/** A batch is judged this long after it was delivered at the earliest, so its turn has started (or failed). */
export const RATE_LIMIT_GRACE_MS = 10_000;
/** How many judged batch ids are kept, so one batch is judged once. */
const KEEP = 200;
/** How much of a batch's text finds it on the screen. */
const PREFIX = 120;
/** A finished turn: an error status is what a refused turn may leave. */
const SETTLED: readonly AgentStatus[] = ["idle", "done", "error"];

/** The provider's error, the whole line and nothing else. */
const LIMITED =
  /^The model provider could not complete the request after \d+ retries \(rate limited\)\. Try again or choose another model with \/model\.$/;
/** A chat message as the inbox received it from the relay: its first line is the chat header. */
const INCOMING = /^\[(Discord|Slack) chat=/;

const squeeze = (s: string): string => s.replace(/\s+/g, "");

/**
 * Whether the screen shows `batch` refused: a provider error line below the batch's text and above the next batch
 * delivered after it. Text is compared with all whitespace removed, so the terminal's line wrapping does not matter;
 * an error line inside the batch's own text does not count.
 */
export function refusedOnScreen(screen: string, batch: Delivered, all: readonly Delivered[]): boolean {
  let flat = "";
  const errors: number[] = [];
  for (const line of screen.split("\n")) {
    if (LIMITED.test(line.trim())) errors.push(flat.length);
    flat += squeeze(line);
  }
  const find = (b: Delivered): number => flat.lastIndexOf(squeeze(b.body).slice(0, PREFIX));
  const start = find(batch);
  if (start < 0 || squeeze(batch.body) === "") return false;
  const end = start + squeeze(batch.body).length;
  const next = Math.min(
    ...all
      .filter((b) => b.at > batch.at)
      .map(find)
      .filter((i) => i >= end),
  );
  return errors.some((at) => at >= end && at < next);
}

const statePath = (root: string): string => join(root, "lead", "ratelimit.json");

/** The judged batch ids, or undefined before the first pass and for a file that cannot be read (judged like a first pass). */
function readState(root: string): readonly string[] | undefined {
  const path = statePath(root);
  if (!existsSync(path)) return undefined;
  try {
    const seen: unknown = Reflect.get(Object(JSON.parse(readFileSync(path, "utf8"))), "seen");
    return Array.isArray(seen) ? seen.filter((s): s is string => typeof s === "string") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One duty pass: each batch the inbox delivered to the lead is judged once, at the first pass that finds the lead's turn
 * over. The chat messages of a batch the screen shows refused with a rate-limit error go to hooks.onLeadRateLimited as
 * `{text}` (one message per paragraph, as the inbox received it), so a fallback can answer them. The first pass only
 * records what was delivered before it: a duty loop that starts late does not answer old messages.
 */
export async function leadRateLimitTick(d: Deps): Promise<DutyEvent[]> {
  const lead = d.store.roles().lead;
  if (lead === undefined) return [];
  const root = d.store.root;
  const all = deliveredToLead(root);
  const seen = readState(root);
  const save = (ids: readonly string[]) =>
    writeAtomic(statePath(root), `${JSON.stringify({ seen: ids.slice(-KEEP) })}\n`);
  if (seen === undefined) {
    save(all.map((b) => b.id));
    return [];
  }
  const due = all.filter((b) => !seen.includes(b.id) && d.now() - b.at >= RATE_LIMIT_GRACE_MS);
  if (due.length === 0) return [];
  let screen: string;
  try {
    const rt = d.runtimes.for(lead);
    if (!SETTLED.includes((await rt.probe(lead)).status)) return [];
    screen = await rt.read(lead, RATE_LIMIT_SCREEN_LINES);
  } catch {
    return [];
  }
  save([...seen, ...due.map((b) => b.id)]);
  const chats = due
    .filter((b) => refusedOnScreen(screen, b, all))
    .flatMap((b) => b.messages)
    .filter((m) => INCOMING.test(m.text));
  if (chats.length === 0) return [];
  const pane = refText(lead);
  void runHook(d, "onLeadRateLimited", { key: "lead", text: chats.map((m) => m.text).join("\n\n"), evidence: pane });
  return [{ pane, action: "lead-rate-limited", detail: `${chats.length} message(s) refused by the model provider` }];
}
