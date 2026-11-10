# dori self-update

`dori self-update` brings the checkout dori runs from (the repository holding `src/cli.ts`) up to
`origin/<default branch>` and restarts the loops on the new code.

```
dori self-update [--check] [--now] [--migrate-prompts]
```

## What one run does

1. `git fetch origin`, then compare HEAD with `origin/HEAD` (falling back to `origin/main`):
   `current`, `behind` (fast-forwardable), `diverged` (local commits) or `dirty` (tracked local edits).
   `--check` prints that line and stops; untracked files do not count as dirty.
2. Only `behind` goes on. `diverged` and `dirty` are left untouched and the reason is told.
3. The target commit is proven **in a throwaway worktree** (`git worktree add --detach` under the temp
   directory): `bun install --frozen-lockfile`, then `bun run typecheck` and `bun test ./test/`. The live
   checkout still runs its proven code while this happens, and the worktree is removed either way.
4. Green checks: `git merge --ff-only <target>` in the checkout, plus `bun install --frozen-lockfile` when
   `bun.lock` changed. A failing install here goes back with `git reset --keep <old>` and reinstalls.
5. Restart, in order: `selfUpdate.services` (`systemctl --user restart`), the `duty-loop` pane, the
   `hourly-loop` pane. Lanes and the lead session are never touched.
6. One `[SELF-UPDATE] <old>..<new>` line to the lead and to `selfUpdate.notify`. Refused, unproven, failed,
   rolled-back and error outcomes are told the same way.

Fast-forward only: no force, no `reset --hard`, no dropping a local commit. Nothing is restarted unless the
checks passed.

## Automatic runs

- `dori merge` of a PR in the checkout's own `origin` repository starts one in the background.
- Every hourly loop pass checks and starts one when the checkout is behind.

Both are detached (`$DORI_HOME/self-update.log`), because the update restarts the loop that triggered it.

The same situation (head, target, state) is retried `MAX_SELF_UPDATE_FAILURES` (2) times; after that automatic
runs stay quiet about it until a new commit lands or someone runs `--now`.

Kill switch: `"selfUpdate": { "auto": false }` in `$DORI_HOME/config.json`, or `DORI_SELF_UPDATE=off`.
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
`$DORI_HOME/prompts/overlay/<name>.md` is appended to the repo's `prompts/<name>.md` after one blank line,
with `{{variables}}` substituted in both.

`dori self-update --migrate-prompts` moves existing local edits there: for each changed `prompts/*.md` whose
diff only appends at the end of the file, the added lines become the overlay, the full diff is kept as
`<name>.local.patch`, and the repo file is restored. A mid-file insertion or any removal is reported as `SKIP`
and left for a person, because the overlay can only come back at the end.
