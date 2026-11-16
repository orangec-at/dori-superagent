# Board: the 채널 tab

The 채널 tab (`/?tab=chan`) shows every messenger the board is connected to, one section per source, in this order:

- **Discord**: the server's text channels everyone can read, each channel's public threads under it, then the
  operator's DMs with the bot. Collected by `src/discord-sync.ts` with `$DORI_HOME/discord/bot.env`.
- **Slack**: the channels the bot is in, each channel's threads with the newest replies (up to 8) under it, then the
  operator's DMs with the bot (`SLACK_ALLOWED_USERS`). Collected by `src/slack-sync.ts`.

A channel opens with its newest messages (100 kept) and a composer. The 프로젝트 tab no longer lists channels; a
project's timeline still shows its recent talk, each row linking to its channel here.

## Reading and sending

Each source keeps its own copy, refreshed on its own 4-second tick: a listing every 10 minutes, otherwise one call per
tick for the next channel or thread. A 429 pauses every call to that source for its `Retry-After`. A page load or a
poll only reads the copies (`$DORI_HOME/board/discord-cache.json`, `$DORI_HOME/board/slack-cache.json`, mode 600);
it never calls Discord or Slack.

Channels and messages are shown only to a viewer who may write (an allowed login on an allowed tailnet device, or the
Cloudflare Access writers); anyone else sees why, and nothing is fetched for them. `POST /chan` (`/discord` from a
page opened before this tab) takes the same writer, origin and CSRF checks as every board write, then sends through the
source whose copy lists the channel key; a key no copy lists is refused before any call. A page names a channel only by
its key (a hash of its id); message text has ids, tokens and webhook URLs masked.

## Slack: where the token stays

Slack is on when `$DORI_HOME/bin/dori-slack-reply` exists. The bot token never reaches the board's machine: a read
runs one short Python script over `ssh ubuntu` that reads `SLACK_BOT_TOKEN` from `~/.hermes/.env` there and calls the
Slack Web API (`users.conversations`, `users.list`, `conversations.history`, `conversations.replies`); a send runs
`dori-slack-reply <channel> <thread_ts>` with the text on stdin, which posts the same way. A message sent from the board
starts with `*재일 (보드)*`, which is how the copy knows it as the operator's.

## Adding a source

A source is a `ChannelSource` (`src/channel-source.ts`): `view()`, `stamp()` and `send(key, text)`, plus an id and a
label. Give its keys a prefix no other source uses, keep a copy refreshed on a tick in `dori board`
(`src/cli-board.ts`), and add it to the `sources` list there; the tab, the composer and `POST /chan` need no change.
