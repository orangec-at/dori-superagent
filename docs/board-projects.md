# Board: the 프로젝트 tab

The 프로젝트 tab lists the Discord channels and DMs first (each with its count of new messages), then every project.

## Channels and new messages

Every channel and DM of the board's Discord copy is listed at the top of the tab, before the projects, on the phone
and the desktop alike. When the copy cannot be shown (no Discord on the board, or a viewer who may not write), the
reason is shown there instead.

A channel's red badge counts the others' messages since the operator last wrote in that channel. On a device that
has opened the channel before, it counts only those that arrived after it was last opened there (kept in the
browser's `localStorage`, key `dori-board-seen`).

## Projects

A project appears while it has work: an open lane, a backlog item, or a lane finished in the last week. Projects named
in `$DORI_HOME/board.json` `projects` (and the standing leads in `leads.json`) appear always, even with no work; with
no activity they sort after the active ones, and their page says `진행 중인 일 없음`.

`projects` maps a project name to either a list of words, or an object:

| field   | type                           | meaning                                                         |
|---------|--------------------------------|-----------------------------------------------------------------|
| `words` | `string[]`                     | work whose key or cwd contains one belongs to the project       |
| `repos` | `string[]` (`owner/repo`)      | work naming a PR in one belongs to it; linked on the page       |
| `dirs`  | `string[]`                     | work whose cwd sits in `~/workspace/<dir>` belongs to it        |
| `note`  | `string`                       | one line shown in the list and on the project's page            |
| `links` | `{ "label", "url" }[]` (http/https) | shown on the project's page                                 |
| `metrics` | `{ "name", "cmd" \| "file" }[]` | numbers shown on the project's status card (below)          |

Every field is optional. An entry of another shape, or with a field of the wrong type (a non-`owner/repo` repo, a
link that is not http/https), is ignored; the rest of the file still applies.

## A project's page

The page opens with a status card, on a phone too:

- **purpose**: the `note`, else the title of the newest lane's brief (its `# ` line, the lane key dropped);
- **badge**: `막힘` (a lane lost or escalated), else `재일 님 차례` (an open ask about the project, a backlog item
  waiting on a decision, a lane ready or waiting), else `진행 중` (a lane at work or a backlog item running), else
  `쉬는 중`;
- **numbers** from `metrics`;
- **재일 님이 결정할 것**: those asks, decisions and lanes, linked;
- **다음 할 일**: the latest report of up to two lanes at work, then the highest-priority open backlog item that
  needs no decision.

An ask belongs to the project its id's key prefix places it in (as a lane key would be), else the project its
question names. The project list shows each project's badge and one line: its first decision, else its first next step.

Below the card: the open lanes, the PRs, **진행 흐름 · 7일** (lane starts, READYs, finishes and losses, backlog
additions, PRs merged and the project's Discord talk of the last week, oldest first, one icon per kind), the backlog,
missions and the week's finished lanes. PRs show their state (`열림`, `병합`, `닫힘`; `확인 전` before the first
collection); open ones, ones merged this week and unread ones of an open lane are listed, the rest fold under
`지난 PR n개`.

### PR states and metrics are cached

`dori board` collects them when it starts and every 10 minutes into `$DORI_HOME/board-hub.json`; a page load or a
poll only reads that file, so it never runs `gh` or a metric command. One `gh pr list` (the newest 200) per repo named
by a PR of a lane active in the last two weeks; a PR that read does not return (gh failed, or the PR is older) keeps
its last state. The whole collection stops after 60 seconds, killing what still runs, and keeps the last file.

A metric is either `cmd`, run with `sh -c` under `timeout` (20 seconds at most, then its whole process group, pipes
and ssh included, is signalled and killed 2 seconds later), or `file`, read (relative to
`$DORI_HOME` unless absolute). Its value is the first non-empty line of the output or file, up to 80 characters; a
failure, an empty output or a timeout shows `알 수 없음`. Only what board.json names runs: the page never takes a
command, and the command itself is never shown. Keep secrets out of what the command prints.

```json
"coupas": {
  "words": ["coupas"],
  "metrics": [
    { "name": "쿠팡 누적 판매 / 목표 150,000원", "cmd": "ssh ubuntu 'cd ~/workspace/coupas && python3 -m coupas sales'" },
    { "name": "게시 수", "file": "coupas-posts.txt" }
  ]
}
```

```json
{
  "projects": {
    "토스인앱": {
      "words": ["tossinapp", "word-pet", "토스인앱"],
      "dirs": ["tossinapp"],
      "note": "앱인토스 미니앱 — 영어 말하기·영단어(단어펫 word-pet)"
    },
    "corpus": {
      "words": ["corpus"],
      "repos": ["orangec-at/corpus"],
      "note": "corpus"
    },
    "Supabase 지원": {
      "words": ["supabase-job", "career-ops"],
      "note": "Supabase Frontend Engineer (Remote, Anywhere) 지원",
      "links": [{ "label": "공고", "url": "https://jobs.ashbyhq.com/supabase/f048dd68-63f8-4f98-9860-3d5a43c09a01" }]
    },
    "older-form": ["word-a", "word-b"]
  }
}
```
