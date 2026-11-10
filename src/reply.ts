import { hostname } from "node:os";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { Refusal } from "./refusal.ts";
import type { Exec } from "./runtime/exec.ts";

/**
 * Where a chat front end wants the answer to a piece of work. A front end (hermes, a Slack or Discord bridge) hands the
 * lead `[reply=<address> from=<name>] <task>`; the lead does the work and answers with `dori reply <address> <text>`.
 */
export type ReplyAddress =
  | { readonly kind: "slack"; readonly channel: string; readonly thread: string }
  | { readonly kind: "discord"; readonly channel: string }
  | { readonly kind: "hermes"; readonly machine: string; readonly profile: string };

const REPLY_FORMS = "slack:<channel>:<thread_ts>, discord:<channel> or hermes:<machine>/<profile>";

const WORD = /^[A-Za-z0-9._-]+$/;

export function parseAddress(text: string): ReplyAddress {
  const [kind, ...rest] = text.split(":");
  const bad = (): never => {
    throw new Refusal(`${text} is not a reply address: use ${REPLY_FORMS}`);
  };
  if (kind === "slack" && rest.length === 2 && WORD.test(rest[0] ?? "") && WORD.test(rest[1] ?? ""))
    return { kind, channel: rest[0]!, thread: rest[1]! };
  if (kind === "discord" && rest.length === 1 && /^\d+$/.test(rest[0] ?? "")) return { kind, channel: rest[0]! };
  if (kind === "hermes" && rest.length === 1) {
    const [machine, profile, extra] = (rest[0] ?? "").split("/");
    if (extra === undefined && WORD.test(machine ?? "") && WORD.test(profile ?? ""))
      return { kind, machine: machine!, profile: profile! };
  }
  return bad();
}

export type ReplyOptions = {
  /** DORI_HOME: the slack and discord senders live in its `bin/`. */
  readonly home: string;
  readonly files?: readonly string[];
  /** This machine's name: a hermes address naming it runs here, any other machine is reached over ssh. */
  readonly self?: string;
};

export function replyCommand(to: ReplyAddress, text: string, o: ReplyOptions): { cmd: string; argv: string[] } {
  const files = o.files ?? [];
  if (files.length > 0 && to.kind !== "slack")
    throw new Refusal(`--file is only sent to slack addresses; ${to.kind} takes text only`);
  switch (to.kind) {
    case "slack":
      return {
        cmd: join(o.home, "bin", "dori-slack-reply"),
        argv: [to.channel, to.thread, ...files.flatMap((f) => ["--file", f]), ...(text ? [text] : [])],
      };
    case "discord":
      return { cmd: join(o.home, "bin", "dori-reply"), argv: [to.channel, text] };
    case "hermes": {
      const argv = ["-p", to.profile, "chat", "-c", "Bot Chat", "-Q", "-q", text];
      const self = o.self ?? hostname();
      if (to.machine === "local" || to.machine === self) return { cmd: "hermes", argv };
      // ssh hands its command to the remote shell, so every word is quoted to arrive as one argument.
      return { cmd: "ssh", argv: [to.machine, ["hermes", ...argv].map(shq).join(" ")] };
    }
  }
}

/** Sends the reply. Resolves when the sender exits 0; throws ReplyError with the sender's own reason otherwise. */
export async function reply(exec: Exec, address: string, text: string, o: ReplyOptions): Promise<void> {
  const to = parseAddress(address);
  if (!text.trim() && (o.files ?? []).length === 0) throw new Refusal("the reply is empty: give --text or --file");
  const { cmd, argv } = replyCommand(to, text, o);
  let result: Awaited<ReturnType<Exec>>;
  try {
    result = await exec(cmd, argv);
  } catch (e) {
    throw new ReplyError(address, `could not run ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.code !== 0)
    throw new ReplyError(
      address,
      `${cmd} exited ${result.code}: ${(result.stderr || result.stdout).trim() || "no output"}`,
    );
}

export class ReplyError extends Error {
  constructor(
    readonly address: string,
    readonly reason: string,
  ) {
    super(`REPLY_FAILED ${address}: ${reason}`);
  }
}
