// What the inbox delivered to the lead, kept so the rate-limit check (lead-ratelimit.ts) takes the refused messages'
// chats and text from the inbox, never from the screen, where a chat message can show any text it likes.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

/** How many delivered batches are kept. */
const KEEP = 50;

/** One batch the inbox delivered to the lead: `body` is the text typed into its pane, `id` stable across passes. */
export type Delivered = {
  readonly id: string;
  readonly at: number;
  readonly body: string;
  readonly messages: readonly { readonly at: number; readonly from: string; readonly text: string }[];
};

/** The text a flush types for a batch: one message as it is, several numbered under one line. */
export function batchBody(batch: readonly QueuedMessage[]): string {
  return batch.length === 1
    ? (batch[0]?.text ?? "")
    : `${batch.length} messages arrived while you were busy:\n\n` +
        batch.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
}

const path = (root: string): string => join(root, "lead", "delivered.jsonl");
/** A message's inbox identity: when it was queued, by whom, and what it says; a second "ping" is another message. */
const key = (m: QueuedMessage): string =>
  `${m.at}:${createHash("sha256").update(`${m.from}\n${m.text}`).digest("hex").slice(0, 12)}`;

/** Written like the other records (tmp file + rename), so a reader never sees half a file. */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function parse(line: string): Delivered | undefined {
  try {
    const e: unknown = JSON.parse(line);
    return typeof Reflect.get(Object(e), "id") === "string" ? (e as Delivered) : undefined;
  } catch {
    return undefined;
  }
}

/** The delivered batches, oldest first; a line that cannot be read (one cut short) is skipped. */
export function deliveredToLead(root: string): Delivered[] {
  if (!existsSync(path(root))) return [];
  return readFileSync(path(root), "utf8")
    .split("\n")
    .flatMap((l) => parse(l) ?? [])
    .slice(-KEEP);
}

/**
 * Records a batch the inbox delivered to `ref` when `ref` is the lead. Called under the lead's inbox lock, after the
 * batch left the inbox: a record that cannot be written is one stderr line, never a failed delivery.
 */
export function recordDelivered(d: Deps, ref: SessionRef, batch: readonly QueuedMessage[]): void {
  const lead = d.store.roles().lead;
  if (lead === undefined || refText(lead) !== refText(ref) || batch.length === 0) return;
  const entry: Delivered = {
    id: batch.map(key).join(","),
    at: d.now(),
    body: batchBody(batch),
    messages: batch.map(({ at, from, text }) => ({ at, from, text })),
  };
  try {
    const file = path(d.store.root);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    const all = deliveredToLead(d.store.root);
    if (readFileSync(file, "utf8").split("\n").length > 2 * KEEP)
      writeAtomic(file, all.map((e) => `${JSON.stringify(e)}\n`).join(""));
  } catch (e) {
    process.stderr.write(
      `dori: recording the delivery to the lead failed (${failureDetail(e)}); its rate-limit check skips it\n`,
    );
  }
}
