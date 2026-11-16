import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One line of DORI_HOME/board-chat.jsonl, the conversation between the operator and the lead on the board: what the
 * operator sent from the board (a request or a decision, with how the delivery went) and every `dori reply board`.
 */
export type ChatMessage = {
  at: number;
  from: "operator" | "lead";
  text: string;
  kind?: "request" | "decide";
  delivery?: string;
};

export const CHAT_TEXT_MAX = 20_000;
const TAIL_BYTES = 512 * 1024;

export const chatPath = (home: string): string => join(home, "board-chat.jsonl");

export function appendChat(home: string, m: ChatMessage): void {
  const path = chatPath(home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...m, text: m.text.slice(0, CHAT_TEXT_MAX) })}\n`);
}

/** The newest `n` messages, oldest first; a line cut by the tail read or not JSON is skipped. */
export function chatTail(home: string, n: number): ChatMessage[] {
  const path = chatPath(home);
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const out: ChatMessage[] = [];
  for (const line of buf.toString("utf8").split("\n")) {
    try {
      const v = JSON.parse(line) as Partial<ChatMessage>;
      if (typeof v.at === "number" && (v.from === "operator" || v.from === "lead") && typeof v.text === "string")
        out.push(v as ChatMessage);
    } catch {
      // the first line of a tail read starts mid-record; it is not a message
    }
  }
  return out.slice(-n);
}
