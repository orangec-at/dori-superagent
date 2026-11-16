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

Every field is optional. An entry of another shape, or with a field of the wrong type (a non-`owner/repo` repo, a
link that is not http/https), is ignored; the rest of the file still applies.

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
