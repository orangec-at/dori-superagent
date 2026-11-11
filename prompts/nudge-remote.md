[duty -> {{key}}] You have been idle for {{minutes}} minutes with no READY on record.
- If the deliverable is done: `printf '%s\n' '<final answer>' | {{dori}} ready {{key}} --evidence "'<link>'"`
- If you are blocked outside this pane: `printf '%s\n' 'WAITING: <blocker>' | {{dori}} report {{key}} --status waiting`
- If one of these commands fails (ssh refused, `bun` or `herdr` not found), your reports never reached the lead: paste the exact error in this pane, then continue.
- Otherwise continue the work now.
