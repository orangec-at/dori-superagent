[duty -> {{key}}] You have been idle for {{minutes}} minutes with no READY on record.
- If the deliverable is done: `printf '%s\n' '<final answer>' | {{dori}} ready {{key}} --evidence "'<link>'"`
- If you are blocked outside this pane: `printf '%s\n' 'WAITING: <blocker>' | {{dori}} report {{key}} --status waiting`
- Otherwise continue the work now.
