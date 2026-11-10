#!/usr/bin/env bun
import { resolve } from "node:path";
import { runBacklog, runDuty, runLoop } from "./cli-loops.ts";
import { status, up } from "./cli-up.ts";
import { done, ready, report, startLane } from "./lanes.ts";
import { mergeGate, parsePr, review } from "./gate.ts";
import { runSelfUpdate } from "./cli-self-update.ts";
import { autoSelfUpdate, originRepo, repoRunner } from "./self-update-run.ts";
import { need, one, parse, textOf, USAGE } from "./cli-args.ts";
import { defaultDeps, ROLES, type Deps } from "./harness.ts";
import { ConfigError, hooksSettled } from "./hooks.ts";
import { send, type SendResult } from "./inbox.ts";
import { inboxList, releaseHeld, sendToShell } from "./inbox-held.ts";
import { Refusal } from "./refusal.ts";
import { runMigrate } from "./migrate.ts";
import { serveDashboard } from "./serve.ts";
import { ReplyError, reply } from "./reply.ts";
import { refText } from "./refs.ts";
import { agentLine, agentsPath, DELEGATE_EXIT, delegate, loadAgents } from "./agents.ts";
import { ConfigError as RuntimeConfigError, RuntimeChoiceError } from "./runtime/select.ts";
import { parseRef } from "./runtime/types.ts";
import type { Role } from "./store-types.ts";

const COMMANDS = new Set([
  "up",
  "role",
  "start",
  "report",
  "ready",
  "send",
  "inbox",
  "duty",
  "review",
  "merge",
  "done",
  "status",
  "loop",
  "backlog",
  "migrate",
  "serve",
  "reply",
  "agents",
  "delegate",
  "self-update",
]);

/** Prints the line for a delivery that did not land now and returns the exit code: HELD 3, everything else 0. */
function deliveryOutcome(result: SendResult | undefined, target: string): number {
  if (result === "HELD") {
    console.log(`HELD ${target}: delivery may or may not have reached the pane; do not resend`);
    return 3;
  }
  if (result === "QUEUED") console.log(`QUEUED ${target}`);
  return 0;
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  // --help is a boolean flag, so the word after it is the command: print the usage instead of running it.
  if (a.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  const [cmd, x] = a.pos;
  if (cmd !== undefined && COMMANDS.has(cmd)) d.usage.touch();
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()));
      return 0;
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const given = a.pos[2];
      const ref = given === undefined ? d.runtimes.selfAny(process.env) : parseRef(given);
      if (given !== undefined && ref === undefined)
        throw new Refusal(`${given} is not a session ref (w1:p3, herdr:w1:p3 or hc:t7)`);
      if (ref === undefined) throw new Refusal(`missing session ref (not inside herdr or hc?)\n\n${USAGE}`);
      d.store.setRole(role, ref);
      console.log(`ROLE ${role}=${refText(ref)}`);
      return 0;
    }
    case "start": {
      const cwd = one(a, "cwd");
      const workspace = one(a, "workspace");
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(workspace !== undefined ? { group: workspace } : {}),
      });
      console.log(`STARTED ${lane.key} pane=${refText(lane.sessionRef)} brief=${lane.brief}`);
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      const sent = await report(d, need(x, "lane key"), await textOf(a), st as "working" | "waiting" | undefined);
      console.log(`REPORTED ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "ready": {
      const sent = await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []);
      console.log(`READY ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "send": {
      const target = need(x, "target");
      const deliver = one(a, "to-shell") === "true" ? sendToShell : send;
      const sent = await deliver(d, target, await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli");
      if (sent === "DELIVERED") console.log(`DELIVERED ${target}`);
      return deliveryOutcome(sent, target);
    }
    case "inbox": {
      const target = need(a.pos[2], "target");
      if (x === "list") {
        const { paneId, entries } = inboxList(d, target);
        if (entries.length === 0) console.log(`EMPTY ${paneId}`);
        for (const e of entries)
          console.log(`${e.index} ${e.state} from ${e.from} queued ${new Date(e.at).toISOString()} ${e.preview}`);
        return 0;
      }
      if (x === "ack" || x === "resend") {
        const index = Number(need(a.pos[3], "entry index (see dori inbox list)"));
        const paneId = releaseHeld(d, target, index, x);
        console.log(
          x === "ack" ? `ACKED ${paneId} ${index}` : `RELEASED ${paneId} ${index}: the next flush delivers it`,
        );
        return 0;
      }
      throw new Refusal(`unknown inbox command ${x}\n\n${USAGE}`);
    }
    case "duty":
      return runDuty(d, a, x);
    case "loop":
      return runLoop(d, a, x);
    case "backlog":
      return runBacklog(d, a, x);
    case "review": {
      const r = await review(d, need(x, "PR"), one(a, "model"));
      console.log(`REVIEW ${x} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    case "merge": {
      const dryRun = one(a, "dry-run") === "true";
      console.log(await mergeGate(d, need(x, "PR"), { dryRun }));
      // A merge into dori's own repo is new code for this checkout: start the self-update in the background. The
      // merge already happened, so nothing in here may throw out of the command.
      if (!dryRun) {
        try {
          const origin = await originRepo(repoRunner(d));
          if (origin !== undefined && parsePr(x!).repo.toLowerCase() === origin.toLowerCase())
            console.log(await autoSelfUpdate(d));
        } catch (e) {
          console.error(`SELF_UPDATE_ERROR ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return 0;
    }
    case "self-update":
      return runSelfUpdate(d, a);
    case "done":
      await done(d, need(x, "lane key"));
      console.log(`DONE ${x}`);
      return 0;
    case "migrate":
      return runMigrate(d, a);
    case "status":
      status(d);
      return 0;
    case "serve": {
      const port = Number(one(a, "port") ?? "8787");
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refusal("--port must be 0-65535");
      const server = serveDashboard(d.store, { host: one(a, "host") ?? "127.0.0.1", port, now: d.now });
      console.log(`SERVING ${server.url.href} home=${d.store.root} (read-only)`);
      return new Promise<number>(() => {});
    }
    case "reply": {
      const address = need(x, "reply address");
      const files = a.flags.get("file") ?? [];
      const text = a.pos.slice(2).join(" ") || one(a, "text") || (files.length > 0 ? "" : await textOf(a));
      try {
        await reply(d.exec, address, text, { home: d.store.root, files });
      } catch (e) {
        if (!(e instanceof ReplyError)) throw e;
        console.error(e.message);
        return 1;
      }
      console.log(`REPLIED ${address}`);
      return 0;
    }
    case "agents": {
      const agents = loadAgents(d.store.root);
      if (agents.length === 0) console.log(`NO_AGENTS ${agentsPath(d.store.root)}`);
      for (const agent of agents) console.log(agentLine(agent));
      return 0;
    }
    case "delegate": {
      const name = need(x, "agent name");
      const seconds = Number(one(a, "timeout") ?? "600");
      if (!(seconds > 0)) throw new Refusal("--timeout must be a positive number of seconds");
      const text = await textOf(a);
      const r = await delegate(d.exec, name, text, { home: d.store.root, timeoutMs: seconds * 1000, now: d.now });
      if (r.outcome === "ok") process.stdout.write(r.output);
      else console.error(`DELEGATE_${r.outcome.toUpperCase()} ${name}: ${r.output}`);
      return DELEGATE_EXIT[r.outcome];
    }
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" ? 0 : 64;
  }
}

if (import.meta.main) {
  const deps = defaultDeps();
  let code = 0;
  try {
    code = await main(process.argv.slice(2), deps);
  } catch (e) {
    if (
      !(
        e instanceof Refusal ||
        e instanceof ConfigError ||
        e instanceof RuntimeConfigError ||
        e instanceof RuntimeChoiceError
      )
    )
      throw e;
    console.error(e.message);
    code = 2;
  } finally {
    await hooksSettled();
    await deps.usage.flush(2000);
  }
  process.exit(code);
}
