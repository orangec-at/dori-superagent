/** Reading a machine's agent configs for the connection map: only names come back, never a value of a secret. */

/** A model or provider name; anything else read from a config is not shown. */
const NAME = /^[\w.:@/+-]{1,80}$/;

const named = (v: string | undefined): string | null => {
  const s = v?.trim().replace(/^["']|["']$/g, "");
  return s && NAME.test(s) ? s : null;
};

/** omo's default provider and model on a machine (~/.omo/agent/settings.json); only those two keys are read. */
export const OMO_SCRIPT = `grep -oE '"default(Provider|Model)": *"[^"]*"' "$HOME/.omo/agent/settings.json"`;
export function parseOmo(out: string | null): { provider: string | null; model: string | null } {
  const get = (k: string): string | null => named(new RegExp(`"default${k}": *"([^"]*)"`).exec(out ?? "")?.[1]);
  return { provider: get("Provider"), model: get("Model") };
}

/**
 * A hermes profile's model block (`default`, `provider`, or a one-line `model: x`) and which channel credentials its
 * .env sets: grep -q, so only the variable name is printed. `profile` is agents.json's, already a plain word.
 */
export const hermesScript = (profile: string): string =>
  [
    `d="$HOME/.hermes/profiles/${profile}"; [ -d "$d" ] || { echo NO_PROFILE; exit 0; }`,
    `sed -n '/^model:/,/^[^ ]/p' "$d/config.yaml" 2>/dev/null | grep -E '^(model: *[^ ]|  (default|provider):)'`,
    `for k in DISCORD_BOT_TOKEN SLACK_BOT_TOKEN TELEGRAM_BOT_TOKEN GH_TOKEN; do grep -q "^$k=." "$d/.env" 2>/dev/null && echo "HAS $k"; done`,
    `grep -qs team-board "$d/SOUL.md" && echo "HAS TEAM_BOARD"; true`,
  ].join("\n");

export type HermesRead = { found: boolean; provider: string | null; model: string | null; has: Set<string> };
export function parseHermes(out: string | null): HermesRead | null {
  if (out === null) return null;
  const lines = out.split("\n");
  if (lines.some((l) => l.trim() === "NO_PROFILE"))
    return { found: false, provider: null, model: null, has: new Set() };
  const val = (re: RegExp): string | null => named(lines.map((l) => re.exec(l)?.[1]).find((v) => v !== undefined));
  return {
    found: true,
    provider: val(/^ {2}provider:\s*(.+)$/),
    model: val(/^ {2}default:\s*(.+)$/) ?? val(/^model:\s*(\S.*)$/),
    has: new Set(lines.flatMap((l) => (l.startsWith("HAS ") ? [l.slice(4).trim()] : []))),
  };
}
