# Lanes on other machines, and adopting running sessions

dori runs on one machine (here: `fedora`). herdr on that machine can drive panes on other machines it has saved as SSH
machines (`herdr --machine <label> <command>`). dori uses that for two things:

- `dori start <key> --machine <label> --cwd <dir on that machine> --brief FILE` opens a lane on that machine.
- `dori adopt <key> --pane <ref> [--machine <label>]` turns an agent session that is already running (omo or Claude
  Code, here or on a saved machine) into a lane, without opening anything.

A pane on another machine is written `<pane>@<machine>` (`w4:p3@ubuntu`, or `herdr:w4:p3@ubuntu`). That ref works
everywhere a ref does: `dori send w4:p3@ubuntu`, `dori inbox list w4:p3@ubuntu`, the lane records, the duty loop, `dori
done`. Every herdr call for it carries `--machine <label>` (and no `--session`: the machine's own herdr server answers).

## 1. Register the machines in fedora's herdr (once)

```sh
herdr machine add brady@brady-910s3l-911s3l --label ubuntu
herdr machine add mac@mac-macmini --label mini     # iOS and Xcode work only
herdr machine status                               # each label: reachable
herdr --machine ubuntu pane list                   # the remote panes, as JSON
```

On 2026-11-10 both were already saved and `reachable` on fedora.

## 2. Let the remote agents reach dori

An agent on ubuntu or mini cannot run the dori CLI there. Its lane rules call dori on fedora over ssh instead:

```sh
printf '%s\n' '<milestone>' | ssh fedora 'DORI_HOME=... bun .../src/cli.ts' report <key>
```

The message text goes on stdin, never in `--text`: ssh joins its arguments into one line that the remote shell splits
again, so a quoted `--text` would arrive as many words. For this to work:

- each machine reaches fedora with `ssh fedora` and no prompt (key auth; checked from ubuntu on 2026-11-10);
- `bun` is on fedora's PATH for a non-interactive ssh command, or `DORI_CMD` names the full command;
- `DORI_SSH_HOST` overrides the name the rules use for fedora (default: fedora's hostname).

`dori start --machine` writes the brief on fedora and tells the agent to read it with `ssh fedora cat <brief>`.

## 3. Adopt a running session

```sh
dori adopt tossinapp --pane w4:p1 --note 'Moving from the Mac to fedora stopped half way; finish the move.'
dori adopt drawhatha-copy --pane w4:p1 --machine mini --brief briefs/drawhatha-123.md
```

`adopt` refuses a pane that is gone, has no agent, or already belongs to an open lane. It writes the brief (the
`--brief` file, the `--note`, then the lane rules) to `DORI_HOME/briefs/<key>.md` and delivers the same text to the pane
once, through its inbox: a busy agent gets it when it is next idle, never in the middle of a turn. From then on the
duty loop watches, nudges and escalates the lane like any other, and `dori done <key>` ends the lane but leaves the
pane open (it was the operator's before dori watched it).

Claude Code's idle input box has the same shape as omo's (a rule, an empty `❯` line, a rule, a short footer), so the
screen check that reads an omo between turns as idle reads an idle Claude Code the same way; a turn (`esc to
interrupt`), a draft in the input or a permission dialog stays not idle. `test/fixtures/screens/claude-*.txt` pin it.

## 4. The sessions to hand over (approved table of 2026-11-10)

Run these once the change is merged and the running dori has it. They need the operator's go-ahead first.

| machine | pane | lane key | what it is doing |
|---|---|---|---|
| fedora | w4:p1 | tossinapp | move from the Mac to fedora, stopped half way |
| fedora | w5:p1 | yogaday | waits for the address file, resumes when it arrives |
| fedora | w6:p1 | vibeguard | rename waits for its merge; three post bodies need the operator |
| ubuntu | w4:p3 | yogaday-pr80 | yogaday PR #80 merge blocked on permissions |
| ubuntu | w5:p1 | supabase-admin-docs | `/docs/admin` comparison table |
| mini | w4:p1 | drawhatha-123 | 1.2.3 copy check |
| mini | w4:p2 | drawhatha-70 | #70 merge and PRD |
| mini | w5:p1 | corpus | Play Console closed test, about to submit (operator confirms) |

```sh
dori adopt tossinapp --pane w4:p1
dori adopt yogaday --pane w5:p1
dori adopt vibeguard --pane w6:p1
dori adopt yogaday-pr80 --pane w4:p3 --machine ubuntu
dori adopt supabase-admin-docs --pane w5:p1 --machine ubuntu
dori adopt drawhatha-123 --pane w4:p1 --machine mini
dori adopt drawhatha-70 --pane w4:p2 --machine mini
dori adopt corpus --pane w5:p1 --machine mini
```

market-radar (ubuntu w1:p3) and coupas (ubuntu w2:p1) are not adopted: they are candidates for the hermes bots.

`dori serve` shows each lane's machine (`local` for fedora) in the lanes table and in `/api/state`.
