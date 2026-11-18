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
- A task that asks for something only a person may do is never handed out. That covers 게시/발행/업로드/올리기/포스팅/제출, 병합/merge and pushing to main/master/origin or force-pushing, 배포/release/deploy/OTA, 결제, 삭제, and 재일 님 개인 계정 글, including English inflections (published, deploying, merging). The check fails closed. A mention counts as a request unless a prohibition is attached right to it: a Korean one directly after it ("게시는 하지 마", "게시하지 말고 …", "배포 금지"), or an English one right before it ("don't publish"). "게시하고 반응이 좋지 않으면" and "게시·Muse 전달은 하지 마" count as requests. "don't forget to publish" is a request. Write such a task anyway if it belongs on the roadmap, and a person picks it up.
- `담당` names that do not look like bot names (a leading `-`, a space) are dropped, and work goes only to bots listed in `agents.json`.
- A task is handed out once. Check it off (`[x]`) when it is done. Changing its text makes it a new task.

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

## 3. Stalled projects

Once an hour, outside the quiet hours, each project's newest activity is computed from roadmap edits, matching delegations, autopilot hand-outs, matching lanes, commits in `경로`, and commits and PRs in `저장소`. A project silent for 24 hours gets:

- `[REPORT <project> 정체] N시간째 활동 없음 (마지막: <source> <time>). 자동 생성: ...` to the lead,
- its next open task handed out: a `[pr]` task becomes backlog item `ap-<project>-<task>` (brief in `autopilot/briefs/`, cwd `경로`), which autostart opens in the same pass; any other task is delegated to its `@bot` or the first owner.

When the bot that would take a stalled project's delegate task is busy (a delegation running, or one handed out within its 30-minute timeout, this pass's idle hand-outs and the delegations this same check already gave to an earlier stalled project included), the project waits for the next hourly check instead of giving that bot a second delegation. A stall is reported at most once a day. Each git or gh call is killed after 10 seconds, and the projects are checked in parallel, so a hung network holds a duty pass for seconds, not minutes. Sources that fail (gh down, no checkout, timeout) are skipped. Posts made outside dori are not visible yet. Note them by editing the roadmap, since an edit counts as activity.

## Files and the board

Everything is under `$DORI_HOME/autopilot/`:

| File | Content |
|---|---|
| `assignments.jsonl` | One line per hand-out: `at`, `project`, `task` (id), `text`, `reason` (`idle`/`stall`), `kind` (`delegate`/`backlog`), `bot` or `item`. A `release` line (with `outcome`, and `final` after the second failure) marks a failed delegation. A task's newest line is its state. |
| `status.json` | Written after every check: each roadmap with every task's `assignment`, each project's `activity` and `stallReportedAt`, each bot's `busy` / `lastAt` / `idleMinutes`, and the newest 100 hand-outs. The board's 에이전트 and 프로젝트 tabs read this file as it is. |
| `state.json` | Check times, stall bookkeeping, and `idleReportedAt` (when each idle bot with nothing to do was last reported). |
| `stop` | Present: no hand-outs and no stall reports (autostart is separate, see above). |

`dori duty autopilot` prints the same object as `status.json`, computed now.

An autostart failure after `dori backlog add` or `dori done` prints `AUTOSTART failed: ...` and never changes that command's exit code.
