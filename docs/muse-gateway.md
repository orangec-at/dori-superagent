# Muse gateway

Muse (an outside assistant) reaches this machine over SSH with a key that can run exactly one program:
`scripts/muse/muse-gw`. Whatever command string Muse sends arrives as `SSH_ORIGINAL_COMMAND`; `muse-gw` splits it with
`shlex` (no shell) and runs one of `state`, `send`, `ask`, `inbox`, `help`. The lead answers Muse with
`scripts/muse/dori-muse-reply`, which appends to the inbox Muse reads.

| File | Role |
|---|---|
| `scripts/muse/muse-gw` | the forced command; every call is appended to `~/.dori/muse/audit.jsonl` |
| `scripts/muse/dori-muse-reply` | the lead's answer: appends `{at, text}` to `~/.dori/muse/inbox.jsonl` and copies it to Discord |
| `~/.dori/muse/inbox.seen` | how many inbox lines Muse has already read |
| `~/.dori/muse/.lock` | `muse-gw` holds this flock while it runs a command |

`inbox --wait N` (N is 1-55 seconds) checks `inbox.jsonl` every 0.5s without taking `.lock`, so `send` and
`dori-muse-reply` never wait on it. It takes the lock only to print the new replies and update `inbox.seen`, and
records the wait in the audit log (`read 1 waited 12s`). Muse can call `inbox --wait 50` once a minute, and a reply
reaches it within seconds.

## Install

The running copies live in `~/.dori/bin/` (that path is what `authorized_keys` names). Install or update them by
copying from the repo, then check they match:

```sh
install -m 700 scripts/muse/muse-gw scripts/muse/dori-muse-reply ~/.dori/bin/
cmp scripts/muse/muse-gw ~/.dori/bin/muse-gw && cmp scripts/muse/dori-muse-reply ~/.dori/bin/dori-muse-reply
```

Copies, not symlinks: a checkout that switches branches must not change what Muse's key runs.

The `authorized_keys` line (one line, set up once, not touched by updates):

```
command="/home/brady/.dori/bin/muse-gw",restrict <MUSE_PUBLIC_KEY> muse
```

`restrict` turns off the shell, forwarding and the pty. Delete the line to cut Muse off.
