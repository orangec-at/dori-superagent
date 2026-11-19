# Autopilot

Work should move without anyone saying "go". The autopilot covers three cases:

1. A lane slot is free while backlog items wait. The next item starts right away (autostart) instead of waiting for the hourly loop.
2. A bot has been idle for hours. It gets the next task of a project it owns.
3. A project has been silent for a day. The lead gets a report, and the project's next task is handed out.

Everything runs inside the duty loop (`dori duty`, once a minute), and autostart also runs after `dori backlog add` and `dori done`. Nothing here merges, deploys, publishes or pays. Bots are asked for drafts and lanes for PRs, and people do the rest.

## Project roadmaps

One markdown file per project, `$DORI_HOME/projects/<project>.md`. The file name is the project id. `examples/projects/` has the seeds this machine started with.

```markdown
# 쿠파스 (coupas)

- 목표: 쿠팡 파트너스 글과 쇼츠로 클릭과 수익을 낸다
- 담당: hongbungi, bido
- 저장소: orangec-at/coupas
- 경로: ~/workspace/personal/coupas
- 키워드: 쿠파스, 쿠팡
- 완료 기준: 매주 글 초안 5개와 쇼츠 검토본 2개가 큐에 있다

## 마일스톤
- 11월: 글 큐 20개

## 다음 할 일
- [x] 첫 상품 3개 초안
- [ ] @hongbungi 다음 주 상품 후보 5개 글 초안
- [ ] 반응 기록 표 정리
- [ ] [pr] 큐 스크립트에 중복 상품 검사 추가
```

| Field | Meaning |
|---|---|
| `목표` / `goal` | Sent with every task, so the bot or lane knows what the work is for. |
| `담당` / `owners` | Bots (names from `agents.json`) that take a task with no `@bot`. The first owner takes it when a stall hands it out. |
| `저장소` / `repo` | `owner/repo`. Its newest commit and PR count as activity. |
| `경로` / `path` | A local checkout. Its newest commit counts as activity, lanes working under it count, and `[pr]` tasks open their lane there. |
| `키워드` / `keywords` | A delegation or lane whose text or key contains one of these words (or the project id) counts as this project's activity. |
| `완료 기준` / `done` | Sent with every task. |

Tasks are `- [ ]` (open) and `- [x]` (done) lines anywhere in the file:

- `@bot` names who does it. Without it, any owner may take it.
- `[pr]` at the start makes it lane work: a backlog item whose lane ends in a PR. Without it, it is a bot delegation (documents, content, research).
- A task that asks for something only a person may do is never handed out. That covers 게시/발행/업로드/올리기/포스팅/제출, 병합/merge and pushing to main/master/origin or force-pushing, 배포/release/deploy/OTA, 결제, 삭제, and 재일 님 개인 계정 글, including English inflections (published, deploying, merging). The check fails closed. A mention counts as a request unless a prohibition is attached right to it: a Korean one directly after it ("게시는 하지 마", "게시하지 말고 …", "배포 금지"), or an English one right before it ("don't publish"). A keyword heading a middle-dot list of single words shares the list's prohibition ("게시·발행·배포 금지", "업로드·게시는 하지 마"); an item with a space breaks the list. "나머지" and "머지않아" are not 머지. "게시하고 반응이 좋지 않으면" and "게시·Muse 전달은 하지 마" count as requests. "don't forget to publish" is a request. Write such a task anyway if it belongs on the roadmap, and a person picks it up.
- `담당` names that do not look like bot names (a leading `-`, a space) are dropped, and work goes only to bots listed in `agents.json`.
- A task is handed out once. Check it off (`[x]`) when it is done, unless the autopilot did (see "Checking off" below). Changing its text makes it a new task.

## 1. Autostart

`startNow` runs the hourly loop's pull step: same candidates (open, no decision, priority then age), same limits, and the same loop lock, so it never races the hourly loop. The limits are the ones the running `dori loop` was started with. It records them in `loop/limits.json`, so its `--max-lanes`, `--max-starts` and `--max-load` flags hold for autostart too. Before any loop has run, autostart falls back to `DORI_MAX_LANES` (default 3), `DORI_MAX_STARTS` per pass (default 2), and `DORI_MAX_LOAD` or the core count for the 1-minute load; at least 10% memory must be free. It runs:

- right after `dori backlog add` (prints `AUTOSTART started <id>`),
- right after `dori done <key>`, since the done lane's slot is free,
- on every duty pass, which picks up slots freed any other way (a READY lane, a host that cooled down).

`dori loop stop` stops autostart too. `DORI_AUTOSTART=off` turns autostart off alone.

A start that fails under autostart is logged on the item but not counted toward the hourly loop's 2 tries (`MAX_ATTEMPTS`, sized for one try an hour), so a one-minute herdr outage cannot turn an item into a question. Autostart tries that item again after an hour, and the hourly loop's own tries still count as before.

## 2. Idle bots

Every 10 minutes a duty pass reads `delegate-runs.jsonl` (starts) and `delegations.jsonl` (ends, now with `endedAt`). A bot is busy while a run has neither ended nor passed its timeout. Otherwise it is idle since its newest end, or since the newest task the autopilot handed it.

A bot idle for `DORI_IDLE_HOURS` (default 2) gets one task: the first open, unassigned, not person-only delegate task, in project order (by file name), that names it with `@bot` or lists it as an owner. The task runs as `dori delegate <bot> --mission autopilot-<project>` in its own process, so a long answer never holds up the duty loop (output in `autopilot/delegate.log`). The text carries the roadmap goal, done criteria, and this rule: drafts and PRs only; no publishing, merging, deploying, paying, deleting data or posting as 재일 님. The lead gets one `[AUTOPILOT] 유휴 봇 배정: ...` line per pass. An idle bot with no task left to hand out is reported instead: `[REPORT autopilot] <bot> 유휴 N시간: 맡길 일 없음 → <its roadmap files>에 추가해 주세요` (every roadmap that lists it as owner or names it with `@bot`, else `projects/*.md`), at most once per 24 hours per bot.

The autopilot runs 24 hours a day by default. `DORI_QUIET_HOURS=A-B` sets quiet hours from A:00 to B:00 KST (`1-8` is the old 01:00-08:00; `22-6` wraps past midnight): nothing is handed out and no stall is reported then. Unset, empty, `off` or `none` means no quiet hours; any other value falls back to `1-8`.

Each delegation's text opens with `[autopilot <project> <task id>]`, so its start and end lines can be found again. On each idle check, a delegation that ended `failed` or `timeout`, started but never recorded an end, or never started within 15 minutes is released (a `release` line in `assignments.jsonl`), and the lead gets `[AUTOPILOT 실패] ...`. A released task can be handed out again. After 2 failures it stays held (`final`) until a person fixes the task or checks it off.

### Checking off

A delegation that ended `ok` is not done by that alone. The autopilot checks its roadmap line off only when all of these hold:

- the run that ended `ok` is this hand-out's run (same bot and task tag, started after the hand-out),
- the task's text names at least one output path, absolute or `~/` (`... ~/.dori/out/report.md에 써줘`),
- every output path in the text is a file on this machine, changed at or after the hand-out.

A path may contain Korean or any other letters (`~/.dori/out/보고서.md`, `~/문서/a.md`). It starts after a space or punctuation, never inside a word. Korean written right after an ASCII letter or digit is a particle, not part of the path: `~/.dori/out/보고서.md에 써줘` names `~/.dori/out/보고서.md`, and `.../a.md에서` names `.../a.md`. Korean right after Korean cannot be told apart from a particle, so it stays in the path: `~/.dori/out/보고서에 써줘` names `~/.dori/out/보고서에`. That file is usually missing, so the task stays with the lead and nothing is checked off by mistake. Give such outputs an extension (`보고서.md에`) or put a space before the particle.

When the text names several paths, the words right after each path tell an output from an input. A path is an output when it is followed by 에 and a verb that writes (써, 쓰, 작성, 저장, 정리, 기록, 남기, 만들, 담아, 추가), or by 로/으로 and a verb that saves (저장, 써, 쓰, 작성, 기록, 내보내, 출력, 남기). A space or 파일 may stand between the path and the particle (`.../보고서 에 써줘`, `.../b.md 파일에 써줘`), and up to three words ending in 로 or 게 may stand before the verb. A negated verb (`쓰지 말고`, `쓰지 않`) marks nothing, and neither does one that says the file already holds the text (`.../log.md에 기록된 오류`, `.../a.md에 쓴 표`, `.../a.md에 정리한 내용`, `.../a.md에 쓰인 규칙`, `.../a.md에 정리해둔 표`, `.../a.md에 작성하신 메모`, `.../a.md에 쓰는 형식`): that path is an input. The imperative `정리해둬` still marks an output. Once any path is marked, only the marked paths must be fresh; the others are inputs and may be old or even missing. When no path is marked, every path must be fresh, as before. With `a.md` read and `b.md` written:

- `~/.dori/out/a.md를 읽고 ~/.dori/out/b.md에 표로 써줘`: `b.md` is the output (a 로 word before the verb).
- `~/.dori/out/a.md를 읽고 결과를 ~/.dori/out/b.md로 저장`: `b.md` is the output (로 and 저장).
- `~/.dori/out/a.md를 읽고 ~/.dori/out/b.md 파일에 써줘`: `b.md` is the output (파일 before 에).
- `~/.dori/out/a.md에 쓰지 말고 ~/.dori/out/b.md에 써줘`: `a.md` is not an output (negated); `b.md` is.
- `~/.dori/out/a.md로 시작해 ~/.dori/out/b.md를 채워`: nothing is marked (시작 and 채우 are not on the lists), so both must be fresh.
- `~/.dori/out/a.md를 ~/.dori/out/b.md에 한 줄 써줘`: nothing is marked (`한 줄` does not end in 로 or 게), so both must be fresh.

An input read as an output only leaves the line open, since it must be fresh too. The other wrong reading can check a line off early: the real output is unmarked (`...로 옮겨줘`, `...에 붙여줘`) while another path is read as marked and changed after the hand-out. So mark outputs plainly (`...에 써줘`, `...로 저장`).

The line is then changed from `[ ]` to `[x]` and nothing else in the file changes (it is re-read first and replaced through a temporary file beside it, which is removed again when the write fails; `loadRoadmaps` reads only `*.md`, never that `.tmp`), a `completed` line goes to `assignments.jsonl`, and the lead gets `[AUTOPILOT 완료] <bot> <project>: <task> -> [x] (<paths>)`. The roadmaps are read again, so the same pass hands out the next task. A completion is not a hand-out: it does not restart the bot's idle time.

Anything else stays with the lead, as before: a task with no path, a relative path, another machine's file (`mac:~/...`, a URL), an output that is missing or older than the hand-out. The task stays held until a person checks it off. The line is never written when its text changed since the hand-out, when several lines have that text, or when it is a `[pr]` or person-only task. A line already checked (by a person, or by a pass stopped before it wrote `completed`) is only recorded. When writing the line fails (for example, `projects/` is not writable), the lead gets `[AUTOPILOT 완료 실패] <bot> <project>: <task> (<error>)` once per delegation and error code (kept in `state.json` `checkOffFailed`), and every later pass retries quietly until it is written. Once the line is written, that delegation's entry is removed from `checkOffFailed`. A `completed` task stays held, so reopening it by hand (`[x]` back to `[ ]`) never hands it out or checks it off again: change its text to hand it out anew. The duty loop is the only writer; a person editing the same roadmap at the same instant may lose that edit or the check.

## 3. Stalled projects

Once an hour, outside the quiet hours, each project's newest activity is computed from roadmap edits, matching delegations, autopilot hand-outs, matching lanes, commits in `경로`, and commits and PRs in `저장소`. A project silent for 24 hours gets:

- `[REPORT <project> 정체] N시간째 활동 없음 (마지막: <source> <time>). 자동 생성: ...` to the lead,
- its next open task handed out: a `[pr]` task becomes backlog item `ap-<project>-<task>` (brief in `autopilot/briefs/`, cwd `경로`), which autostart opens in the same pass; any other task is delegated to its `@bot` or the first owner.

When the bot that would take a stalled project's delegate task is busy (a delegation running, or one handed out within its 30-minute timeout, this pass's idle hand-outs and the delegations this same check already gave to an earlier stalled project included), the project waits for the next hourly check instead of giving that bot a second delegation. A stall is reported at most once a day. Each git or gh call is killed after 10 seconds, and the projects are checked in parallel, so a hung network holds a duty pass for seconds, not minutes. Sources that fail (gh down, no checkout, timeout) are skipped. Posts made outside dori are not visible yet. Note them by editing the roadmap, since an edit counts as activity.

## Files and the board

Everything is under `$DORI_HOME/autopilot/`:

| File | Content |
|---|---|
| `assignments.jsonl` | One line per hand-out: `at`, `project`, `task` (id), `text`, `reason` (`idle`/`stall`), `kind` (`delegate`/`backlog`), `bot` or `item`. A `release` line (with `outcome`, and `final` after the second failure) marks a failed delegation, and a `completed` line one checked off. A task's newest line is its state. |
| `status.json` | Written after every check: each roadmap with every task's `assignment`, each project's `activity` and `stallReportedAt`, each bot's `busy` / `lastAt` / `idleMinutes`, and the newest 100 hand-outs. The board's 에이전트 and 프로젝트 tabs read this file as it is. |
| `state.json` | Check times, stall bookkeeping, `idleReportedAt` (when each idle bot with nothing to do was last reported), and `checkOffFailed` (the check-off failure each delegation last reported, until its line is written). |
| `stop` | Present: no hand-outs and no stall reports (autostart is separate, see above). |

`dori duty autopilot` prints the same object as `status.json`, computed now.

An autostart failure after `dori backlog add` or `dori done` prints `AUTOSTART failed: ...` and never changes that command's exit code.
