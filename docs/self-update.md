# dori self-update

`dori self-update` brings the checkout dori runs from (the repository holding `src/cli.ts`) up to
`origin/<default branch>` and restarts the loops on the new code.

```
dori self-update [--check] [--now] [--migrate-prompts]
```

## What one run does

1. `git fetch origin`, then compare HEAD with `origin/HEAD` (falling back to `origin/main`):
   `current`, `behind` (fast-forwardable), `diverged` (local commits), `off-branch` (a branch other than the
   default one is checked out; a detached HEAD is fine) or `dirty` (tracked local edits).
   `--check` prints that line and stops; untracked files do not count as dirty.
2. Only `behind` goes on. `diverged`, `off-branch` and `dirty` are left untouched and the reason is told.
3. The target commit is proven **in a throwaway worktree** (`git worktree add --detach` under the temp
   directory): `bun install --frozen-lockfile`, then `bun run typecheck` and `bun test ./test/`. The live
   checkout still runs its proven code while this happens, and the worktree is removed either way. These run
   with an allowlisted environment (`PATH`, locale, `TERM`, `TZ`, `TMPDIR`): no tokens, no ssh agent, and `HOME`
   and `DORI_HOME` inside the worktree; only bun's package cache is shared.
4. Green checks: `git merge --ff-only <target>` in the checkout, plus `bun install --frozen-lockfile` when
   `bun.lock` changed. A failing install here goes back with `git reset --keep <old>` and reinstalls.
5. Restart, in order: `selfUpdate.services` (`systemctl --user restart`), the `duty-loop` pane, the
   `hourly-loop` pane. Each loop gets SIGTERM, finishes the pass it is in (it only stops between passes, so no
   nudge is half-typed and no inbox batch goes out twice), and is started again with the command `dori up` used.
   The restart waits up to 15 minutes for that pass; past that it reports the command to run by hand. Lanes and
   the lead session are never touched.
6. One `[SELF-UPDATE] <old>..<new>` line to the lead and to `selfUpdate.notify`. Refused, unproven, failed,
   rolled-back and error outcomes are told the same way.

Fast-forward only: no force, no `reset --hard`, no dropping a local commit. Nothing is restarted unless the
checks passed.

## Automatic runs

Automatic runs are **on by default**, with no `selfUpdate` config at all:

- `dori merge` of a PR in the checkout's own `origin` repository starts one in the background.
- Every hourly loop pass that ran starts one (not a skipped pass, not `--once`).

Both are detached (`$DORI_HOME/self-update.log`), because the update restarts the loop that triggered it. The
trigger itself makes no network call; the detached run fetches with prompts disabled, a 30 s ssh connect timeout
(unless the repo sets its own `core.sshCommand`) and a 60 s https stall limit, so nothing waits on a person or a
dead network.

The same situation (head, target, state) is retried `MAX_SELF_UPDATE_FAILURES` (2) times; after that automatic
runs stay quiet about it until a new commit lands or someone runs `--now`. A run that errors (origin unreachable,
a broken `config.json`) counts the same way under its error message, so an outage is told twice, not every hour.

Kill switch: `"selfUpdate": { "auto": false }` in `$DORI_HOME/config.json`, or `DORI_SELF_UPDATE=off`. A
stopped hourly loop (`dori loop stop`) also starts no self-update until `dori loop resume`.
`--now` runs by hand whatever the switch says.

**Protect the default branch.** With `auto` on, anything pushed to `origin/<default branch>` is installed,
tested and restarted on this host within the hour, not only what passed the `dori merge` CLEAR gate. Require
pull requests on that branch.

## Config

```json
{
  "selfUpdate": {
    "auto": true,
    "notify": "discord:<channel id>",
    "services": ["dori-serve"],
    "checks": [["bun", "run", "typecheck"], ["bun", "test", "./test/"]]
  }
}
```

`notify` is a `dori reply` address. `checks` replaces the default commands.

## Keeping the checkout clean

A fast-forward needs a clean checkout, so machine-specific prompt rules live outside it: anything in
`$DORI_HOME/prompts/overlay/<name>.md` is appended to the repo's `prompts/<name>.md` as written (one blank line
is added only when the overlay does not start with one), with `{{variables}}` substituted in both.

`dori self-update --migrate-prompts` moves existing local edits there: for each changed `prompts/*.md` whose
diff only appends at the end of the file, the added lines become the overlay, the full diff is kept as
`<name>.local.patch`, and the repo file is restored. It moves a file only when the overlay renders the edited file
byte for byte; a mid-file insertion, any removal, or an append that does not start with a blank line is reported as
`SKIP` and left for a person. It takes the same lock as an update, since both touch the checkout.
