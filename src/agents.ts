import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { Refusal } from "./refusal.ts";
import type { Exec, ExecResult } from "./runtime/exec.ts";

/**
 * A bot dori can hand work to: a hermes profile on this machine (empty host) or on another one reached over ssh.
 * `DORI_HOME/agents.json` lists them; `roles.json` stays for the pane roles (lead, duty).
 */
export type Agent = {
  readonly name: string;
  readonly host: string;
  readonly profile: string;
  readonly role: string;
  readonly description: string;
};

const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// An ssh destination: [user@]host. It never starts with "-", so ssh cannot read it as an option.
const HOST = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const agentsPath = (home: string): string => join(home, "agents.json");

/** The configured agents; none when agents.json does not exist. A malformed file is refused with what is wrong. */
export function loadAgents(home: string): Agent[] {
  const path = agentsPath(home);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Refusal(`${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) throw new Refusal(`${path} must be an array of {name, host, profile, role, description}`);
  return raw.map((entry: unknown, i): Agent => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const field = (k: string): string => {
      const v = e[k] ?? "";
      if (typeof v !== "string") throw new Refusal(`${path} entry ${i}: ${k} must be a string`);
      return v;
    };
    const agent = {
      name: field("name"),
      host: field("host"),
      profile: field("profile"),
      role: field("role"),
      description: field("description"),
    };
    if (!WORD.test(agent.name)) throw new Refusal(`${path} entry ${i}: name must match ${WORD}`);
    if (!WORD.test(agent.profile)) throw new Refusal(`${path} entry ${i}: profile must match ${WORD}`);
    if (agent.host !== "" && !HOST.test(agent.host))
      throw new Refusal(`${path} entry ${i}: host must be empty (this machine) or [user@]host`);
    return agent;
  });
}

/**
 * The process that runs one instruction on the agent, as an argv array: the text is one argument and never part of a
 * local shell string. ssh hands its command to the remote shell, so there every word is quoted to arrive as one.
 */
export function delegateCommand(agent: Agent, text: string): { cmd: string; argv: string[] } {
  const argv = ["-p", agent.profile, "chat", "-Q", "-q", text];
  if (agent.host === "") return { cmd: "hermes", argv };
  return { cmd: "ssh", argv: [agent.host, ["hermes", ...argv].map(shq).join(" ")] };
}

export type DelegateOutcome = "ok" | "failed" | "timeout";
export type Delegation = { readonly outcome: DelegateOutcome; readonly code: number | null; readonly output: string };

export type DelegateOptions = { readonly home: string; readonly timeoutMs: number; readonly now: () => number };

/** Runs the instruction on the named agent, waits at most timeoutMs, and appends one line to delegations.jsonl. */
export async function delegate(exec: Exec, name: string, text: string, o: DelegateOptions): Promise<Delegation> {
  const agents = loadAgents(o.home);
  const agent = agents.find((a) => a.name === name);
  if (agent === undefined)
    throw new Refusal(
      `no agent ${name} in ${agentsPath(o.home)}${agents.length ? ` (known: ${agents.map((a) => a.name).join(", ")})` : ""}`,
    );
  if (!text.trim()) throw new Refusal("the instruction is empty: give --text or pipe it on stdin");
  const { cmd, argv } = delegateCommand(agent, text);
  const at = o.now();
  let proc: { kill(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = exec(cmd, argv, { onSpawn: (p) => (proc = p) }).catch(
    (e: unknown): ExecResult => ({ code: -1, stdout: "", stderr: `could not run ${cmd}: ${String(e)}` }),
  );
  const expired = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), o.timeoutMs)));
  const result = await Promise.race([run, expired]);
  clearTimeout(timer);
  let d: Delegation;
  if (result === "timeout") {
    proc?.kill();
    d = { outcome: "timeout", code: null, output: `no answer within ${o.timeoutMs / 1000}s` };
  } else {
    const output = result.code === 0 ? result.stdout : (result.stderr || result.stdout).trim() || "no output";
    d = { outcome: result.code === 0 ? "ok" : "failed", code: result.code, output };
  }
  const line = {
    at: new Date(at).toISOString(),
    agent: name,
    text: text.slice(0, 200),
    outcome: d.outcome,
    code: d.code,
    output: d.output.slice(0, 2000),
  };
  appendFileSync(join(o.home, "delegations.jsonl"), `${JSON.stringify(line)}\n`);
  return d;
}

/** `dori delegate` exit codes: 0 the agent answered, 1 it failed or could not start, 124 it ran out of time. */
export const DELEGATE_EXIT: Record<DelegateOutcome, number> = { ok: 0, failed: 1, timeout: 124 };

export const agentLine = (a: Agent): string =>
  `${a.name} ${a.host || "local"} ${a.profile} ${a.role || "-"}${a.description ? ` - ${a.description}` : ""}`;
