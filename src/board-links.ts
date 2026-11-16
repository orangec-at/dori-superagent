import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { type Agent, isSshHost, loadAgents } from "./agents.ts";
import { BOT_CHANNELS, LEAD, leadChannels, ruleThreads, unlistedProfile } from "./board-links-channels.ts";
import { HERMES_SCAN, hermesScript, OMO_SCRIPT, parseHermes, parseHermesScan, parseOmo } from "./board-links-read.ts";
import type { Exec, ExecOptions } from "./runtime/exec.ts";
import { isOn, leadState, loadLeads, type StandingLead } from "./standing.ts";
import type { Store } from "./store.ts";

/**
 * The board's connection map: who runs where, on which CLI and model, and over which channels the operator, the lead,
 * its lanes and the bots reach each other. The hourly loop (refreshLinks) and `dori agents map` collect it into
 * DORI_HOME/board-links.json and the board only reads that file. Other machines are read over ssh, read-only. Only names leave a machine: a model and provider
 * name, whether a channel's credential is set (never its value), never a token, key, webhook URL or channel id.
 */

/** Seen from the actor: `in` comes to it, `out` goes from it, `both` either way. */
export type LinkDir = "both" | "in" | "out";
export type LinkChannel = { name: string; with: string; dir: LinkDir };
/** `relay`: a hermes profile that carries the operator's Slack threads to the lead. */
export type LinkKind = "lead" | "duty" | "standing" | "lane" | "bot" | "relay";
export type LinkActor = {
  /** The board row id (`lead`, `bot:<name>`, `lane:<key>`, `standing:<domain>`) or `duty`. */
  id: string;
  kind: LinkKind;
  label: string;
  computer: string;
  cli: string;
  /** null: not readable, shown as 알 수 없음. */
  provider: string | null;
  model: string | null;
  /** Where provider and model were read. */
  source: string;
  /** The actors that hand it work, and how. */
  from: string[];
  via: string | null;
  channels: LinkChannel[];
};
export type LinkSnapshot = { generatedAt: number; actors: LinkActor[]; unknown: string[] };

export const UNKNOWN = "알 수 없음";

/** The machine's name in the map: an ssh destination without its user (`mac@mac-macmini` -> mac-macmini). */
export const computerOf = (host: string, local: string): string => (host === "" ? local : host.replace(/^.*@/, ""));

type Run = (host: string, script: string) => Promise<string | null>;
/** A host that is not a plain `[user@]host` (a lane's machine is free text) is never handed to ssh: read as unknown. */
const runner =
  (exec: Exec, onSpawn?: ExecOptions["onSpawn"]): Run =>
  async (host, script) => {
    if (host !== "" && !isSshHost(host)) return null;
    const argv = host === "" ? ["-c", script] : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, script];
    const r = await exec(host === "" ? "sh" : "ssh", argv, onSpawn ? { onSpawn } : undefined).catch(() => null);
    return r && r.code === 0 ? r.stdout : null;
  };

function standingLeads(home: string): StandingLead[] {
  try {
    return loadLeads(home).filter((l) => isOn(leadState(home, l.domain)));
  } catch {
    return [];
  }
}

/** The bound on one whole collection; past it every sh/ssh still running is killed and what it would read is unknown. */
export const COLLECT_DEADLINE_MS = 45_000;

/**
 * `onSpawn` gets every sh/ssh process it starts, so a caller that gives up can kill them. `deadlineMs`: the whole
 * collection's bound (COLLECT_DEADLINE_MS).
 */
export type CollectOptions = {
  now: number;
  agentCmd: string;
  local?: string;
  onSpawn?: ExecOptions["onSpawn"];
  deadlineMs?: number;
};

function agentsOrBroken(home: string): Agent[] | null {
  try {
    return loadAgents(home);
  } catch {
    return null;
  }
}

/** Reads every actor's machine once and returns the map; nothing is written. */
export async function collectLinks(exec: Exec, store: Store, o: CollectOptions): Promise<LinkSnapshot> {
  const procs = new Set<{ kill(): void }>();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      for (const p of procs) p.kill();
      resolve(null);
    }, o.deadlineMs ?? COLLECT_DEADLINE_MS);
  });
  const read = runner(exec, (p) => {
    procs.add(p);
    o.onSpawn?.(p);
  });
  const run: Run = (host, script) => (expired ? Promise.resolve(null) : Promise.race([read(host, script), deadline]));
  try {
    return await collect(run, store, o, () => expired);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(run: Run, store: Store, o: CollectOptions, expired: () => boolean): Promise<LinkSnapshot> {
  const home = store.root;
  const local = o.local ?? hostname().split(".")[0]!;
  const cli = basename(o.agentCmd.split(" ")[0] ?? o.agentCmd);
  const omoOn = new Map<string, Promise<{ provider: string | null; model: string | null }>>();
  const omo = (machine: string) => {
    if (cli !== "omo") return Promise.resolve({ provider: null, model: null });
    const known = omoOn.get(machine);
    if (known) return known;
    const p = run(machine, OMO_SCRIPT).then(parseOmo);
    omoOn.set(machine, p);
    return p;
  };
  const omoSource = `${cli} 기본 설정 (~/.omo/agent/settings.json)`;
  const session = async (
    a: Omit<LinkActor, "provider" | "model" | "source" | "cli" | "computer">,
    machine = "",
    runtime = "herdr",
  ): Promise<LinkActor> => ({
    ...a,
    computer: computerOf(machine, local),
    cli: `${cli} · ${runtime}`,
    ...(await omo(machine)),
    source: omoSource,
  });

  const standing = standingLeads(home);
  const lanes = store.lanes().filter((l) => l.status !== "done");
  const listed = agentsOrBroken(home);
  const agents: Agent[] = listed ?? [];
  const roles = (() => {
    try {
      return JSON.parse(readFileSync(join(home, "roles.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const actors = await Promise.all([
    session({ id: "lead", kind: "lead", label: `${LEAD} (lead)`, from: [], via: null, channels: leadChannels(home) }),
    ...(roles["duty"]
      ? [
          session({
            id: "duty",
            kind: "duty",
            label: "duty (당번)",
            from: [],
            via: null,
            channels: [
              { name: "nudge", with: "lane", dir: "out" },
              { name: "dori send", with: LEAD, dir: "out" },
            ],
          }),
        ]
      : []),
    ...standing.map((l) =>
      session({
        id: `standing:${l.domain}`,
        kind: "standing",
        label: `${l.domain} lead`,
        from: ["lead"],
        via: "dori lead",
        channels: [{ name: "dori send", with: LEAD, dir: "both" }, ...ruleThreads(l)],
      }),
    ),
    ...lanes.map((l) =>
      session(
        {
          id: `lane:${l.key}`,
          kind: "lane",
          label: l.key,
          from: ["lead"],
          via: "dori start · send",
          channels: [
            { name: "dori report·ready", with: LEAD, dir: "out" },
            { name: "dori send", with: LEAD, dir: "in" },
          ],
        },
        l.sessionRef.machine ?? "",
        l.sessionRef.runtime,
      ),
    ),
    ...agents.map(async (a): Promise<LinkActor> => {
      const h = parseHermes(await run(a.host, hermesScript(a.profile)));
      return {
        id: `bot:${a.name}`,
        kind: "bot",
        label: /^([^(:]+)\(/.exec(a.description)?.[1]?.trim() || a.name,
        computer: computerOf(a.host, local),
        cli: "hermes",
        provider: h?.provider ?? null,
        model: h?.model ?? null,
        source:
          h === null ? "ssh로 읽지 못함" : h.found ? `hermes 프로필 ${a.profile} config.yaml` : "hermes 프로필 없음",
        from: ["lead", ...standing.filter((l) => l.bots.includes(a.name)).map((l) => `standing:${l.domain}`)],
        via: a.host === "" ? "dori delegate" : "dori delegate (ssh)",
        channels: BOT_CHANNELS.filter(([k]) => h?.has.has(k)).map(([, c]) => c),
      };
    }),
    ...[...new Set(["", ...agents.map((a) => a.host)])].map(async (host): Promise<LinkActor[]> => {
      const scan = parseHermesScan(await run(host, HERMES_SCAN));
      const computer = computerOf(host, local);
      const known = new Set(agents.filter((a) => computerOf(a.host, local) === computer).map((a) => a.profile));
      return (scan?.profiles ?? [])
        .filter((p) => !known.has(p.name))
        .map((p) => unlistedProfile(p.name, p.read, computer, scan!.gateway));
    }),
  ]).then((all) => all.flat());
  const unknown = [
    ...(listed === null ? [`봇 목록: ${UNKNOWN} (agents.json을 읽지 못함)`] : []),
    ...(expired()
      ? [`수집 시간 초과 (${Math.ceil((o.deadlineMs ?? COLLECT_DEADLINE_MS) / 1000)}초): 그 뒤 답은 받지 않음`]
      : []),
    ...actors.flatMap((a) => {
      const missing = [a.provider ? "" : "provider", a.model ? "" : "모델"].filter(Boolean);
      return missing.length ? [`${a.label}: ${missing.join("·")} (${a.source})`] : [];
    }),
  ];
  return { generatedAt: o.now, actors, unknown };
}
