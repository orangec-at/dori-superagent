import { hostname } from "node:os";
import { shq } from "./delivery.ts";
import { type Deps, prompt } from "./harness.ts";

/**
 * The ssh name another machine reaches this one (the one running dori) by: `DORI_SSH_HOST`, else this host's name.
 * An agent on a saved herdr machine cannot run the dori CLI there, so its lane rules call it over ssh.
 */
export const doriHost = (): string => process.env["DORI_SSH_HOST"] || hostname();

/** The dori command as a lane on `machine` runs it: over ssh back to this machine; here, as is. */
export const doriFor = (d: Deps, machine: string | undefined): string =>
  machine ? `ssh ${doriHost()} ${shq(d.doriCmd)}` : d.doriCmd;

/**
 * The lane rules appended to a brief. A lane on another machine gets the ssh form, with message text on stdin: ssh joins
 * its arguments into one line the remote shell splits again, so a quoted `--text` would arrive as many words.
 */
export const laneFooter = (d: Deps, key: string, machine: string | undefined): string =>
  prompt(
    machine ? "lane-footer-remote.md" : "lane-footer.md",
    { key, dori: doriFor(d, machine), host: doriHost() },
    d.store.root,
  );

/** The duty loop's nudge for an idle lane, in the same form as its rules. */
export const nudgeText = (d: Deps, key: string, minutes: number, machine: string | undefined): string =>
  prompt(
    machine ? "nudge-remote.md" : "nudge.md",
    { key, minutes: String(minutes), dori: doriFor(d, machine) },
    d.store.root,
  );
