import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { shq } from "./delivery.ts";
import { type Deps, prompt } from "./harness.ts";

/** `remote` in `$DORI_HOME/config.json`: `{ "ssh": "brady@fedora", "path": "/home/brady/.local/bin" }`, both optional. */
type RemoteConfig = { readonly ssh: string | undefined; readonly path: string | undefined };

function remoteConfig(home: string): RemoteConfig {
  let text: string;
  try {
    text = readFileSync(join(home, "config.json"), "utf8");
  } catch {
    return { ssh: undefined, path: undefined };
  }
  const remote = (JSON.parse(text) as { remote?: Record<string, unknown> }).remote ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  return { ssh: str(remote["ssh"]), path: str(remote["path"]) };
}

/**
 * The ssh target another machine reaches this one (the one running dori) by: `DORI_SSH_HOST`, else `remote.ssh` in
 * config.json, else `<user>@<host>` of this machine. A bare host name is not enough: the Mac mini logs in as `mac`.
 */
export const doriHost = (d: Deps): string =>
  process.env["DORI_SSH_HOST"] || remoteConfig(d.store.root).ssh || `${userInfo().username}@${hostname()}`;

/**
 * The directories a non-interactive ssh command on this machine needs on PATH: `DORI_REMOTE_PATH`, else `remote.path`
 * in config.json, else the directories of the running bun and of herdr. A login shell sets PATH; `ssh host cmd` does not.
 */
export const remotePath = (d: Deps): string => {
  const set = process.env["DORI_REMOTE_PATH"] || remoteConfig(d.store.root).path;
  if (set) return set;
  const herdr = Bun.which("herdr");
  return [...new Set([dirname(process.execPath), ...(herdr ? [dirname(herdr)] : [])])].join(":");
};

/** The dori command as a lane on `machine` runs it: over ssh back to this machine, with PATH set; here, as is. */
export const doriFor = (d: Deps, machine: string | undefined): string =>
  machine ? `ssh ${doriHost(d)} ${shq(`PATH=${remotePath(d)}:$PATH ${d.doriCmd}`)}` : d.doriCmd;

/**
 * The lane rules appended to a brief. A lane on another machine gets the ssh form, with message text on stdin: ssh joins
 * its arguments into one line the remote shell splits again, so a quoted `--text` would arrive as many words.
 */
export const laneFooter = (d: Deps, key: string, machine: string | undefined): string =>
  prompt(
    machine ? "lane-footer-remote.md" : "lane-footer.md",
    { key, dori: doriFor(d, machine), host: doriHost(d) },
    d.store.root,
  );

/** The duty loop's nudge for an idle lane, in the same form as its rules. */
export const nudgeText = (d: Deps, key: string, minutes: number, machine: string | undefined): string =>
  prompt(
    machine ? "nudge-remote.md" : "nudge.md",
    { key, minutes: String(minutes), dori: doriFor(d, machine) },
    d.store.root,
  );
