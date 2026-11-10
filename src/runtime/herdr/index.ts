import { type Exec, spawnExec } from "../exec.ts";
import type {
  AgentIdentity,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { deliver, keys, type Sleep, submitTyped, typeIntoShell } from "./deliver.ts";
import { HerdrCli } from "./exec.ts";
import { probe } from "./probe.ts";
import { close, create, createGroup, type Env, list, self, start } from "./sessions.ts";

export type { Sleep } from "./deliver.ts";
export { HerdrError } from "./exec.ts";
export { omoScreenIdle } from "./probe.ts";

export type HerdrOptions = { readonly env?: Env; readonly sleep?: Sleep };

/**
 * herdr behind the session runtime interface: a session is a pane, its group the pane's workspace. A ref with a
 * `machine` is a pane on that saved SSH machine: every call for it goes through `herdr --machine <label>`.
 */
export class HerdrRuntime implements SessionRuntime {
  readonly kind = "herdr" as const;
  private readonly cli: HerdrCli;
  private readonly remote = new Map<string, HerdrCli>();
  private readonly env: Env;
  private readonly sleep: Sleep;

  constructor(
    private readonly exec: Exec = spawnExec,
    session: string | undefined = process.env["DORI_HERDR_SESSION"],
    options: HerdrOptions = {},
  ) {
    this.cli = new HerdrCli(exec, session);
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /** The CLI for this machine, or for a saved SSH machine. */
  private on(machine: string | undefined): HerdrCli {
    if (!machine) return this.cli;
    let cli = this.remote.get(machine);
    if (cli === undefined) {
      cli = new HerdrCli(this.exec, undefined, machine);
      this.remote.set(machine, cli);
    }
    return cli;
  }

  self(): SessionRef | undefined {
    return self(this.env);
  }

  createGroup(label: string, cwd: string, machine?: string): Promise<string> {
    return createGroup(this.on(machine), label, cwd);
  }

  async create(spec: CreateSpec): Promise<SessionRef> {
    const ref = await create(this.on(spec.machine), spec);
    return spec.machine ? { ...ref, machine: spec.machine } : ref;
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return start(this.on(ref.machine), ref.id, command);
  }

  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    return list(this.cli, filter?.group);
  }

  probe(ref: SessionRef, opts?: { readonly omoWithoutAgent?: boolean }): Promise<Probe> {
    return probe(this.on(ref.machine), ref.id, true, undefined, opts?.omoWithoutAgent ?? false);
  }

  read(ref: SessionRef, lines: number): Promise<string> {
    return this.on(ref.machine).read(ref.id, lines);
  }

  /** herdr types whatever the status word says (the caller decided), so `when` and `force` change nothing here. */
  deliver(ref: SessionRef, text: string, _opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.on(ref.machine), ref.id, text, this.sleep);
  }

  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult> {
    return submitTyped(this.on(ref.machine), ref.id, into);
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return typeIntoShell(this.on(ref.machine), ref.id, text);
  }

  keys(ref: SessionRef, pressed: readonly Key[]): Promise<void> {
    return keys(this.on(ref.machine), ref.id, pressed);
  }

  close(ref: SessionRef, scope: CloseScope = "session"): Promise<void> {
    return close(this.on(ref.machine), ref, scope);
  }
}
