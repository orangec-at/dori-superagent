import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./agents.ts";
import { agentsOrNone } from "./board-avatars.ts";
import { botLabel } from "./board-bots.ts";
import type { BotLive } from "./board-live.ts";

/**
 * The 사무실 tab's 팀별 view: board.json `office.teams` (`[{ id, name, members: [bot name], note }]`) groups the bots of
 * agents.json into rooms. A team without a name, whose members are not a list, or that names a bot agents.json does not
 * have is skipped, the rest are used; none leaves the tab exactly as before. Under each team's sign: how many pieces of
 * work went between its members in the last 7 days (delegations.jsonl: work given to A whose text names B, a teammate,
 * is one for the pair A·B) and the busiest pair. Only counts and names reach the page, never a delegation's text.
 */
export type OfficeTeam = { id: string; name: string; members: string[]; note: string | null };
/** A team's last 7 days: the pieces of work between its members and the pair with the most (null when none). */
export type TeamPairs = { total: number; top: { a: string; b: string; n: number } | null };
/** `pairs` per team id; null when delegations.jsonl could not be read (`failed` says why, for one log line). */
export type OfficeTeams = { teams: OfficeTeam[]; pairs: Record<string, TeamPairs> | null; failed: string | null };
/** A delegation as the counts read it: when it started, to which bot, and its instruction. */
export type Given = { at: number; agent: string; text: string };

export const PAIR_DAYS = 7;
const DAY_MS = 86_400_000;
const NAME = /^[^\n<>]{1,40}$/;
const NOTE = /^[^\n<>]{1,120}$/;
const ID = /^[A-Za-z0-9._-]{1,40}$/;

const str = (v: unknown, ok: RegExp): string | null => (typeof v === "string" && ok.test(v.trim()) ? v.trim() : null);

/** board.json `office.teams`, each member one of `known` (agents.json's names); an invalid entry is skipped. */
export function officeTeams(home: string, known: readonly string[]): OfficeTeam[] {
  const path = join(home, "board.json");
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(path, "utf8")) as { office?: { teams?: unknown } }).office?.teams;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw.flatMap((v: unknown, i): OfficeTeam[] => {
    const t = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const name = str(t["name"], NAME);
    const members = t["members"];
    if (!name || !Array.isArray(members) || members.length === 0) return [];
    if (!members.every((m): m is string => typeof m === "string" && known.includes(m))) return [];
    const id = str(t["id"], ID) ?? `team-${i + 1}`;
    if (ids.has(id)) return [];
    ids.add(id);
    return [{ id, name, members: [...new Set(members)], note: str(t["note"], NOTE) }];
  });
}

/** The 팀별 rooms: the leads' seats on top, a room per team (a bot in several is in each), then the bots in none. */
export type TeamRooms = { lead: BotLive[]; teams: { team: OfficeTeam; bots: BotLive[] }[]; none: BotLive[] };

/** The seats split by team; within a room the seats keep agents.json order, as in the 머신별 view. */
export function teamRooms(bots: BotLive[], teams: OfficeTeam[]): TeamRooms {
  const seats = bots.filter((b) => !b.row);
  const inAny = new Set(teams.flatMap((t) => t.members));
  return {
    lead: bots.filter((b) => b.row),
    teams: teams.map((team) => ({ team, bots: seats.filter((b) => team.members.includes(b.name)) })),
    none: seats.filter((b) => !inAny.has(b.name)),
  };
}

/** The bots in more than one team: their desks say 겸임. */
export const dualMembers = (teams: OfficeTeam[]): Set<string> => {
  const seen = new Set<string>();
  const dual = new Set<string>();
  for (const m of teams.flatMap((t) => t.members)) (seen.has(m) ? dual : seen).add(m);
  return dual;
};

/** Does `text` name a bot by any of `names`: a Latin name as a whole word in any case, a Korean name anywhere in it. */
export function names(text: string, words: readonly string[]): boolean {
  return words.some((w) =>
    /^[\x20-\x7e]+$/.test(w)
      ? new RegExp(`(?<![A-Za-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i").test(text)
      : text.includes(w),
  );
}

/**
 * Each team's pairs from the delegations that started in the 7 days up to `now`: work given to a member whose text
 * names another member (by any of `words`, its name and Korean name) counts once for that pair; naming itself does not.
 */
export function teamPairs(
  given: Given[],
  teams: OfficeTeam[],
  words: ReadonlyMap<string, readonly string[]>,
  now: number,
): Record<string, TeamPairs> {
  const recent = given.filter((g) => g.at <= now && g.at > now - PAIR_DAYS * DAY_MS);
  const out: Record<string, TeamPairs> = {};
  for (const t of teams) {
    const n = new Map<string, number>();
    for (const g of recent) {
      if (!t.members.includes(g.agent)) continue;
      for (const b of t.members)
        if (b !== g.agent && names(g.text, words.get(b) ?? [b])) {
          const [x, y] = [g.agent, b].sort((p, q) => t.members.indexOf(p) - t.members.indexOf(q));
          n.set(`${x}|${y}`, (n.get(`${x}|${y}`) ?? 0) + 1);
        }
    }
    let top: TeamPairs["top"] = null;
    for (const [k, c] of n)
      if (!top || c > top.n) {
        const [a = "", b = ""] = k.split("|");
        top = { a, b, n: c };
      }
    out[t.id] = { total: [...n.values()].reduce((s, c) => s + c, 0), top };
  }
  return out;
}

const read = new Map<string, { key: string; given: Given[] }>();

/** Every delegation in DORI_HOME/delegations.jsonl, read again only when the file changes; throws when it cannot. */
export function delegationsGiven(home: string): Given[] {
  const path = join(home, "delegations.jsonl");
  const st = statSync(path);
  const key = `${st.size}|${st.mtimeMs}`;
  const hit = read.get(path);
  if (hit?.key === key) return hit.given;
  const given = readFileSync(path, "utf8")
    .split("\n")
    .flatMap((l): Given[] => {
      try {
        const v = JSON.parse(l) as Record<string, unknown>;
        const at = typeof v["at"] === "string" ? Date.parse(v["at"]) : Number.NaN;
        return typeof v["agent"] === "string" && !Number.isNaN(at)
          ? [{ at, agent: v["agent"], text: String(v["text"] ?? "") }]
          : [];
      } catch {
        return [];
      }
    });
  read.set(path, { key, given });
  return given;
}

/** The teams of DORI_HOME at `now` and their pairs; no teams reads nothing more. */
export function teamsState(home: string, now: number, agents: Agent[] = agentsOrNone(home)): OfficeTeams {
  const teams = officeTeams(
    home,
    agents.map((a) => a.name),
  );
  if (!teams.length) return { teams, pairs: null, failed: null };
  const words = new Map(agents.map((a) => [a.name, [a.name, botLabel(a)]] as const));
  try {
    return { teams, pairs: teamPairs(delegationsGiven(home), teams, words, now), failed: null };
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
    return { teams, pairs: null, failed: `delegations.jsonl unreadable (${why})` };
  }
}

/** A log line for each new reason the counts could not be read; a read that works again resets it. */
export function teamsLog(log: (line: string) => void): (failed: string | null) => void {
  let last: string | null = null;
  return (failed) => {
    if (failed && failed !== last) log(`BOARD_OFFICE_TEAMS ${failed}`);
    last = failed;
  };
}
