import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";
import { KEY_RE } from "./store-types.ts";

/**
 * A decision the lead asks the operator on the phone board (`dori ask`). One JSON file per ask in DORI_HOME/asks/,
 * written like the other store records (tmp file + rename). `sent`: the board delivered an answer to the lead; the ask
 * stays open until the lead closes it with `dori ask close`.
 */
export type Ask = {
  id: string;
  question: string;
  options: { key: string; text: string }[];
  recommend?: string;
  link?: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
  sent?: { choice: string; at: number };
};

export const ASK_LIMITS = { question: 500, option: 200, options: 6, link: 500 } as const;
const OPTION_KEY = /^[A-Z0-9]{1,3}$/;
/** Words `dori ask` reads as subcommands, so an ask can never be named after one. */
const SUBCOMMANDS = new Set(["close", "list"]);

const dir = (home: string): string => join(home, "asks");
const file = (home: string, id: string): string => {
  if (!KEY_RE.test(id)) throw new Refusal(`ask id must match ${KEY_RE}`);
  return join(dir(home), `${id}.json`);
};

function save(home: string, ask: Ask): void {
  mkdirSync(dir(home), { recursive: true });
  const path = file(home, ask.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ask, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readAsk(home: string, id: string): Ask | undefined {
  const path = file(home, id);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ask) : undefined;
}

/** Every ask, oldest first. A file that is not JSON is skipped, so one broken ask cannot take the board down. */
export function asks(home: string): Ask[] {
  if (!existsSync(dir(home))) return [];
  return readdirSync(dir(home))
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir(home), f), "utf8")) as Ask];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Parses `--option A=text` values: a key of 1-3 capitals or digits, then the option text. */
export function parseOptions(values: readonly string[]): Ask["options"] {
  if (values.length < 1 || values.length > ASK_LIMITS.options)
    throw new Refusal(`give 1-${ASK_LIMITS.options} --option KEY=text`);
  const options = values.map((v) => {
    const at = v.indexOf("=");
    const key = v.slice(0, Math.max(at, 0)).trim();
    const text = v.slice(at + 1).trim();
    if (at < 0 || !OPTION_KEY.test(key)) throw new Refusal(`--option must be KEY=text with KEY like A or B2, got ${v}`);
    if (!text || text.length > ASK_LIMITS.option)
      throw new Refusal(`option ${key} text must be 1-${ASK_LIMITS.option} characters`);
    return { key, text };
  });
  if (new Set(options.map((o) => o.key)).size !== options.length) throw new Refusal("option keys must be unique");
  return options;
}

/** Registers (or replaces) an open ask. A replaced ask loses its `sent` mark: it is a new question. */
export function askAdd(
  home: string,
  id: string,
  o: { question: string; options: Ask["options"]; recommend?: string; link?: string; now: number },
): Ask {
  if (SUBCOMMANDS.has(id)) throw new Refusal(`ask id "${id}" is a dori ask subcommand`);
  file(home, id);
  const question = o.question.trim();
  if (!question || question.length > ASK_LIMITS.question)
    throw new Refusal(`--question must be 1-${ASK_LIMITS.question} characters`);
  if (o.recommend !== undefined && !o.options.some((x) => x.key === o.recommend))
    throw new Refusal(
      `--recommend ${o.recommend} is not one of the options (${o.options.map((x) => x.key).join(", ")})`,
    );
  if (o.link !== undefined && (!/^https?:\/\/\S+$/.test(o.link) || o.link.length > ASK_LIMITS.link))
    throw new Refusal("--link must be an http(s) URL");
  const ask: Ask = {
    id,
    question,
    options: o.options,
    ...(o.recommend !== undefined ? { recommend: o.recommend } : {}),
    ...(o.link !== undefined ? { link: o.link } : {}),
    status: "open",
    createdAt: o.now,
  };
  save(home, ask);
  return ask;
}

export function askClose(home: string, id: string, now: number): Ask {
  const ask = readAsk(home, id);
  if (!ask) throw new Refusal(`no ask ${id}`);
  if (ask.status === "closed") return ask;
  const closed: Ask = { ...ask, status: "closed", closedAt: now };
  save(home, closed);
  return closed;
}

/** Marks the answer the board delivered. Refused for an unknown or closed ask, or a choice that is not an option. */
export function markSent(home: string, id: string, choice: string, now: number): Ask {
  const ask = openAsk(home, id, choice);
  const sent: Ask = { ...ask, sent: { choice, at: now } };
  save(home, sent);
  return sent;
}

/** The open ask the choice answers; Refusal when there is none or the choice is not one of its options. */
export function openAsk(home: string, id: string, choice: string): Ask {
  const ask = KEY_RE.test(id) ? readAsk(home, id) : undefined;
  if (ask?.status !== "open") throw new Refusal(`no open ask ${id}`);
  if (!ask.options.some((o) => o.key === choice)) throw new Refusal(`${choice} is not an option of ${id}`);
  return ask;
}
