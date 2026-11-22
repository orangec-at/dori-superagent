import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_ROLE, type LeadPane, type LeadSeen, leadLive, TURN_LINES, TURN_MARK } from "./board-lead-live.ts";
import type { BotLive } from "./board-live.ts";
import type { Exec } from "./runtime/exec.ts";
import { paneStatus } from "./runtime/herdr/probe.ts";

/**
 * The other computers' leads on the 사무실 tab: each `office.remotes` entry of DORI_HOME/board.json is one more room
 * (`machine`) with its lead's seat (`lead`, its name; `role`, default 조율(lead)). The board process reads them over
 * `ssh <ssh>` every 30 s under a time limit, never on a page load: the lead's pane as that machine's roles.json names
 * it and its newest lane start, from that machine's dori home (`home`, default ~/.dori). A machine that is off or that
 * ssh cannot reach is 연결 안 됨; the tab never waits on it.
 */
export type OfficeRemote = { machine: string; ssh: string; lead: string; role: string; home: string | null };
/** One ssh read: what came back, or null when ssh failed, timed out or answered something else. */
export type RemoteRead = { pane: LeadPane | null; seen: LeadSeen | null } | null;

export const REMOTE_EVERY_MS = 30_000;
const TIMEOUT_S = 15;
const LANES_READ = 20;
export const REMOTE_OFF = "연결 안 됨";
const SSH = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;
const HOME = /^\/[A-Za-z0-9._/-]{1,200}$/;
const NAME = /^[^\n<>]{1,40}$/;

const str = (v: unknown, ok: RegExp): string | null => (typeof v === "string" && ok.test(v.trim()) ? v.trim() : null);

/** board.json `office.remotes`; an entry missing its machine, ssh target or lead name, or with an unsafe one, is skipped. */
export function officeRemotes(home: string): OfficeRemote[] {
  const path = join(home, "board.json");
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(path, "utf8")) as { office?: { remotes?: unknown } }).office?.remotes;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: Record<string, unknown>) => {
    const [machine, ssh, lead] = [str(v?.["machine"], NAME), str(v?.["ssh"], SSH), str(v?.["lead"], NAME)];
    if (!machine || !ssh || !lead) return [];
    return [{ machine, ssh, lead, role: str(v["role"], NAME) ?? LEAD_ROLE, home: str(v["home"], HOME) }];
  });
}

/**
 * The shell run on the remote: its lead's pane (`herdr pane get`), @@BUSY when its screen shows a turn (as turnShown
 * reads it: the mark in the last non-blank lines), and its newest
 * lane records, each after a marker line. PATH gets the user's own bin directories: a non-login ssh shell lacks them.
 */
export function remoteScript(home: string | null): string {
  const h = home ?? "$HOME/.dori";
  return [
    `H="${h}"; PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`,
    `L=$(sed -n 's/.*"lead"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$H/roles.json" 2>/dev/null | head -n 1); L=\${L#herdr:}`,
    `echo "@@LEAD $L"; [ -n "$L" ] && herdr pane get "$L" 2>/dev/null | head -c 20000`,
    `[ -n "$L" ] && herdr pane read "$L" --lines 30 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n ${TURN_LINES} | grep -q "${TURN_MARK}" && { echo; echo "@@BUSY"; }`,
    `for f in $(ls -t "$H"/lanes/*.json 2>/dev/null | head -n ${LANES_READ}); do echo; echo "@@LANE"; head -c 200000 "$f"; done; echo`,
  ].join("\n");
}

const json = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** What remoteScript printed: the pane (null when herdr gave none) and the newest lane start. */
export function parseRemote(stdout: string): RemoteRead {
  const [, ...parts] = stdout.split(/^@@/m);
  const lead = parts.find((p) => p.startsWith("LEAD"));
  if (lead === undefined) return null;
  const got = json(lead.slice(lead.indexOf("\n") + 1).trim());
  const pane = (got?.["result"] as Record<string, unknown> | undefined)?.["pane"] as
    | Record<string, unknown>
    | undefined;
  const title = typeof pane?.["title"] === "string" ? pane["title"] : undefined;
  let seen: LeadSeen | null = null;
  for (const p of parts.filter((x) => x.startsWith("LANE"))) {
    const lane = json(p.slice(4).trim());
    const log = Array.isArray(lane?.["log"]) ? (lane["log"] as Record<string, unknown>[]) : [];
    for (const e of log)
      if (e?.["kind"] === "start" && typeof e["at"] === "number" && e["at"] > (seen?.at ?? Number.NEGATIVE_INFINITY))
        seen = { at: e["at"], what: `lane ${String(lane?.["key"])} 시작` };
  }
  const status = pane ? paneStatus(pane) : null;
  const busy = status !== "gone" && parts.some((p) => p.startsWith("BUSY"));
  return { pane: status ? { status: busy ? "working" : status, ...(title ? { title } : {}) } : null, seen };
}

/** A remote lead's seat: as the local lead's from a read, else 연결 안 됨. It has no record on this board to link to. */
export function remoteSeat(r: OfficeRemote, read: RemoteRead | undefined): BotLive {
  const who = { row: `remote:${r.machine}`, label: r.lead, role: r.role };
  const seat = leadLive(read?.pane ?? null, read?.seen ?? null, r.machine, who);
  const off = { status: "unknown", word: REMOTE_OFF, task: null, at: null, running: 0 } as const;
  return { ...seat, name: r.machine, linkless: true, ...(read ? {} : off) };
}

/**
 * Reads every remote now and then (`tick`, one at a time per remote); `seats` answers from the last reads at once. A
 * failed read is one log line each time its reason changes.
 */
export function remoteLeads(exec: Exec, remotes: OfficeRemote[], log: (line: string) => void = () => {}) {
  const reads = new Map<string, RemoteRead>();
  const failed = new Map<string, string>();
  const busy = new Set<string>();
  const readOne = async (r: OfficeRemote): Promise<void> => {
    if (busy.has(r.machine)) return;
    busy.add(r.machine);
    try {
      const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", r.ssh, remoteScript(r.home)];
      const out = await exec("timeout", ["-k", "2", String(TIMEOUT_S), "ssh", ...ssh]).catch((e: unknown) => ({
        code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      }));
      const read = out.code === 0 ? parseRemote(out.stdout) : null;
      reads.set(r.machine, read);
      const why = read ? "" : `exit ${out.code}: ${(out.stderr.trim().split("\n")[0] ?? "") || "no answer"}`;
      if (why && why !== failed.get(r.machine)) log(`BOARD_REMOTE_LEAD ${r.machine} failed (${why})`);
      failed.set(r.machine, why);
    } finally {
      busy.delete(r.machine);
    }
  };
  return {
    tick: (): Promise<void> => Promise.all(remotes.map(readOne)).then(() => undefined),
    seats: (): BotLive[] => remotes.map((r) => remoteSeat(r, reads.get(r.machine))),
  };
}
