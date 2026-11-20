import { Refusal } from "./refusal.ts";

export const USAGE = `dori - a proactive multi-session harness on herdr or hc + omo

  dori up [--cwd DIR]                         open lead, duty, duty loop and hourly loop sessions; every agent session
                                              dori opens (up, start, lead start, lead rotation, migrate) gets
                                              ENABLE_CLAUDEAI_MCP_SERVERS=false (claude.ai connectors off) unless
                                              config.json sets "claudeaiConnectors": true (the one-shot reviewer of
                                              dori review is not such a session and does not get it)
  dori role <lead|duty|duty-loop|hourly-loop> [REF]
                                              register a session (w1:p3, herdr:w1:p3, hc:t7) under that role (default: this one)
                                              a pane on a saved herdr machine is REF@machine (w4:p3@ubuntu)
  dori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omo session, brief + lane rules
             [--machine M --cwd DIR]          ... on a saved herdr SSH machine (herdr --machine M); DIR is on M
             [--mission ID]                   ... tagged with a mission id the board groups its work under
  dori adopt <key> --pane REF [--machine M] [--brief FILE] [--note T] [--cwd DIR]
                                              watch a running agent session (omo or Claude Code) as a lane: its
                                              rules, brief and note are delivered once; done leaves the pane open
  dori report <key> --text T [--status working|waiting]
  dori ready <key> --text T --evidence LINK [--evidence LINK ...]
  dori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                  [--to-shell]                operator only: type this one message into a pane with no agent
  dori inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  dori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  dori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  dori duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  dori duty stop [--text WHY] | resume | status   kill switch
  dori duty autopilot                         roadmaps, idle bots and hand-outs as JSON (docs/autopilot.md)
  dori budget set <key|default> --usd N       a lane's cost limit in DORI_HOME/budgets.json; each duty pass reads the
                                              last $<n> on a working or waiting lane's screen: [BUDGET 80%] and
                                              [BUDGET OVER] go to the lead once each, and an OVER lane is not nudged
  dori budget show                            the limits, then each open lane's cost / limit
  dori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  dori loop stop [--text WHY] | resume | status   kill switch and last run
  dori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  dori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY] | priority <id> --priority 1-9
  dori backlog import <owner/repo> [--label dori] [--cwd DIR]   open labelled issues -> items
  dori timer add <id> --at <ISO|+30m> --text T [--every 30m|2h|1d]
                                              a follow-up in DORI_HOME/timers.json: once due, the duty loop sends
                                              [TIMER <id>] T to the lead once (a repeating one moves to its next time)
  dori timer list [--all] | cancel <id>       pending timers (--all: done and cancelled too) / retire one
  dori review <owner/repo#N> [--model M]      fresh omo reviewer at the exact head -> receipt
  dori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  dori done <key>                             lead closes a READY lane
  dori self-update [--check] [--now]          prove origin's default branch in a throwaway worktree (install,
                                              typecheck, tests), then fast-forward this checkout and restart the duty
                                              and hourly loops and selfUpdate.services; [SELF-UPDATE] old..new to the
                                              lead and selfUpdate.notify. Nothing is restarted unless the checks pass;
                                              a situation that failed twice is left alone until --now or a new commit.
                                              Automatic runs (after dori merge, each hourly pass) are opt-in:
                                              "selfUpdate": { "auto": true } in config.json; DORI_SELF_UPDATE=off
  dori self-update --migrate-prompts          move local prompts/*.md end-of-file additions to
                                              DORI_HOME/prompts/overlay/ (anything else is reported as SKIP)
  dori migrate [--to hc|herdr] (--lane K | --role lead|duty|duty-loop|hourly-loop | --all) [--dry-run]
               [--wait-minutes N] [--resume]  hand sessions over to another runtime; MIGRATED, SKIP, DEFERRED,
                                              or MIGRATE_ROLLBACK (exit 3) per session
  dori lead rotate --now                      ask the lead for a handoff (DORI_HOME/handoff/<time>.md), then start a new
                                              lead session in the same pane with it; the duty loop does this by itself
                                              once the session's context grew leadRotation.maxTokens (300000) past its
                                              baseline (the footer's last reading in the session's first 10 minutes:
                                              system prompt, tools, handoff), or it is maxHours (24) old; never within
                                              60 min of a rotation or a failed try ("auto": false or
                                              DORI_LEAD_ROTATION=off turns that off); every line goes to
                                              DORI_HOME/lead/rotations.log; hooks.onLeadRotation gets failures and
                                              timeouts at once, and rotations per leadRotation.notify: "daily" (default:
                                              at the first duty pass of a day, one [LEAD ROTATIONS] line per earlier day
                                              that had rotations; still sent when auto is off), "each" (every
                                              [LEAD ROTATED] line) or "log" (rotations.log only)
                                              "leadModel": "provider/id" in config.json: --model for the lead only (up, rotation)
  dori lead start|stop <domain> [--text WHY]  open or close a standing lead (DORI_HOME/leads.json): while it runs, its
                                              domain's lane messages and backlog decisions go to it; the lead still gets
                                              READY and an ESCALATE summary. Off or gone: everything goes to the lead
  dori lead extend <domain> [--days 7] | status   keep a trial going / show on|off, trial days left, lanes
  dori status
  dori serve [--port N] [--host H]            read-only dashboard: / (HTML, refreshes every 30s) and /api/state (JSON);
                                              default 127.0.0.1:8787
  dori board [--port N] [--host H]            phone board on loopback (default 127.0.0.1:7401), behind tailscale serve:
                                              decisions, a request box, bot cards, projects; writes only from an allowed
                                              Tailscale-User-Login (DORI_HOME/board.json allow) and go to the lead's inbox
  dori ask <id> --question Q --option A=T [--option B=T ...] [--recommend A] [--link URL]
     [--for jaeil|bokyung] [--project P]      put a decision on the board (--for: who answers, default jaeil; bokyung's are
                                              read only on the board); ask close <id> takes it off, ask list shows them
  dori reply <address> <text> [--file F ...]  answer a front end: slack:<channel>:<thread_ts> (files too),
                                              discord:<channel>, hermes:<machine>/<profile> (its Bot Chat);
                                              REPLIED, or REPLY_FAILED <address>: <reason> and exit 1
  dori agents                                 bots in DORI_HOME/agents.json: name, host (local), profile, role
  dori agents avatars                         save each bot's picture for the board to DORI_HOME/avatars/<name>.png:
                                              its Discord account picture, else its hermes profile's assets/avatar.png
  dori agents map                             collect the board's 연결 tab (who runs where, CLI, provider/model, channel
                                              names; other machines over ssh, read-only, no secrets) into
                                              DORI_HOME/board-links.json; UNKNOWN <what> for each value it could not read
                                              (the hourly loop also refreshes it each run, within 60s)
  dori delegate <name> --text T [--timeout S] run hermes -p <profile> chat -Q -q T on that bot (ssh when it has a host)
                                              and print its answer; DELEGATE_FAILED exit 1, DELEGATE_TIMEOUT exit 124
                                              (default 600s); every run is logged to DORI_HOME/delegations.jsonl
                [--mission ID]                tag the run with a mission id the board groups its work under

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then dori inbox ack or dori inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.`;

export type Args = { pos: string[]; flags: Map<string, string[]> };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "once",
  "force",
  "dry-run",
  "to-shell",
  "all",
  "resume",
  "help",
  "check",
  "now",
  "migrate-prompts",
  "auto",
]);

export function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    // A value flag at the very end (--text $MSG with MSG unset) has no value; reading it as "true" would send that word.
    const value = BOOLEAN_FLAGS.has(name) ? "true" : argv[++i];
    if (value === undefined) throw new Refusal(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

export const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
export const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

export async function textOf(a: Args): Promise<string> {
  const given = one(a, "text");
  if (given === undefined && process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  const text = given ?? (await Bun.stdin.text()).trim();
  // An unset variable (--text "$MSG") or an empty pipe would type a blank message into the pane and print DELIVERED.
  if (!text.trim()) throw new Refusal("the message is empty: give --text or pipe the message on stdin");
  return text;
}
