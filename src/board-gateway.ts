import type { Agent } from "./agents.ts";
import type { Exec } from "./runtime/exec.ts";

/**
 * What each bot did on the messengers (Slack, Discord, ...) outside `dori delegate`: read from its hermes gateway's own
 * session index on the bot's machine, ~/.hermes/sessions/sessions.json and a profile's own
 * ~/.hermes/profiles/<p>/sessions/sessions.json. Each `agent:<profile>:<platform>:...` entry has `updated_at` (the
 * session's last write, the machine's local time) and `active_turn_started_at` (set while a turn runs). `platform:
 * local` entries are `dori delegate` runs, already on the delegation records, and are left out. The script prints
 * only times and platform names per profile, never a message. The board process runs it every minute under a time
 * limit (over ssh for a bot with a host), never on a page load; a machine it cannot read is null (모름).
 *
 * hermes (gateway/session_lifecycle.py, read 2026-11-22) writes the marker with `updated_at` a moment after it when a
 * turn starts, and clears the marker when the turn ends (`clear_turn_active`, best effort; a gateway that crashed
 * leaves it until its next start). A turn that writes again after it started (update_session after the reply) and
 * still carries a marker is one whose clear was lost: a marker `ACTIVE_SLACK_S` older than its own session's
 * `updated_at` is dropped. A trailing `Z` is read as UTC on any python3 (fromisoformat takes it only from 3.11).
 */
export type GatewaySeen = {
  at: number | null;
  platform: string | null;
  active: number | null;
  activePlatform: string | null;
};
/** A bot's messenger activity from the last read of its machine: null when that machine has not been read. */
export type GatewayLookup = (a: Agent) => GatewaySeen | null;

export const GATEWAY_EVERY_MS = 60_000;
const TIMEOUT_S = 15;
const NONE: GatewaySeen = { at: null, platform: null, active: null, activePlatform: null };
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLATFORM = /^[a-z][a-z0-9_-]{0,19}$/;

const ACTIVE_SLACK_S = 5;

export const GATEWAY_SCRIPT = `import datetime, glob, json, os
def ms(v):
    if v.endswith("Z"): v = v[:-1] + "+00:00"
    try: return int(datetime.datetime.fromisoformat(v).timestamp() * 1000)
    except Exception: return None
out = {}
h = os.path.expanduser("~/.hermes")
for p in [h + "/sessions/sessions.json"] + glob.glob(h + "/profiles/*/sessions/sessions.json"):
    try: s = json.load(open(p))
    except Exception: continue
    for k, v in s.items():
        part = k.split(":")
        if not isinstance(v, dict) or len(part) < 3 or part[0] != "agent" or v.get("platform") in (None, "local"): continue
        o = out.setdefault(part[1], {"at": None, "platform": None, "active": None, "activePlatform": None})
        at, active = ms(v.get("updated_at") or ""), ms(v.get("active_turn_started_at") or "")
        if at and active and at > active + ${ACTIVE_SLACK_S * 1000}: active = None
        for x, t, pf in ((at, "at", "platform"), (active, "active", "activePlatform")):
            if x and (o[t] is None or x > o[t]): o[t] = x; o[pf] = v.get("platform")
print(json.dumps(out))
`;

/** The command run on a bot's ssh host: the script, passed as base64 so no shell quoting touches it. */
export const remoteGatewayCommand = (): string =>
  `python3 -c "import base64; exec(base64.b64decode('${Buffer.from(GATEWAY_SCRIPT).toString("base64")}'))"`;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const word = (v: unknown): string | null => (typeof v === "string" && PLATFORM.test(v) ? v : null);

/** What the script printed, per profile; null when it is not the script's answer. */
export function parseGateway(stdout: string): Record<string, GatewaySeen> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, GatewaySeen> = {};
  for (const [p, v] of Object.entries(raw as Record<string, Record<string, unknown>>))
    if (PROFILE.test(p) && v && typeof v === "object")
      out[p] = {
        at: num(v["at"]),
        platform: word(v["platform"]),
        active: num(v["active"]),
        activePlatform: word(v["activePlatform"]),
      };
  return out;
}

/**
 * Reads every machine the bots of `agents()` run on (`tick`, one read at a time per machine); `seen` answers from the
 * last reads at once. A failed read is one log line each time its reason changes, and that machine's bots are null.
 */
export function gatewayReader(exec: Exec, agents: () => Agent[], log: (line: string) => void = () => {}) {
  const reads = new Map<string, Record<string, GatewaySeen> | null>();
  const failed = new Map<string, string>();
  const busy = new Set<string>();
  const readOne = async (host: string): Promise<void> => {
    if (busy.has(host)) return;
    busy.add(host);
    try {
      const run =
        host === ""
          ? ["python3", "-c", GATEWAY_SCRIPT]
          : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", host, remoteGatewayCommand()];
      const out = await exec("timeout", ["-k", "2", String(TIMEOUT_S), ...run]).catch((e: unknown) => ({
        code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      }));
      const read = out.code === 0 ? parseGateway(out.stdout) : null;
      reads.set(host, read);
      const why = read ? "" : `exit ${out.code}: ${(out.stderr.trim().split("\n")[0] ?? "") || "no answer"}`;
      if (why && why !== failed.get(host)) log(`BOARD_GATEWAY ${host || "local"} failed (${why})`);
      failed.set(host, why);
    } finally {
      busy.delete(host);
    }
  };
  return {
    tick: (): Promise<void> =>
      Promise.all([...new Set(agents().map((a) => a.host))].map(readOne)).then(() => undefined),
    seen: ((a) => {
      const read = reads.get(a.host);
      return read ? (read[a.profile] ?? NONE) : null;
    }) satisfies GatewayLookup,
  };
}
