import type { DiscordMessage } from "./discord-text.ts";

/**
 * A messenger the board's 채널 tab shows and sends through: Discord and Slack now; Telegram or Muse would add one more
 * adapter with the same shape. Each keeps its own copy (a cache refreshed on its own tick) that page loads read without
 * calling the messenger. A channel's key is unique across sources (each source prefixes its own) and never its id.
 */
export type ChannelMessage = DiscordMessage;
export type Channel = {
  key: string;
  name: string;
  kind: "channel" | "dm" | "thread";
  /** A thread's parent channel key. */
  parent?: string;
  archived?: boolean;
  locked?: boolean;
  /** The ~/.dori/projects.json alias for its id. */
  project?: string;
  messages: ChannelMessage[];
};
export type ChannelView = {
  channels: Channel[];
  syncedAt: number | null;
  error: string | null;
  skipped: string[];
};
export type SendResult = "sent" | "failed";
export type ChannelCopy = {
  view(): ChannelView;
  /** Grows when the copy changes; the board's version hash includes it so open pages reload. */
  stamp(): number;
  send(key: string, text: string): Promise<SendResult>;
};
export type ChannelSource = ChannelCopy & { id: string; label: string };
/** One source as a page shows it. */
export type SourceView = { id: string; label: string; view: ChannelView };

/** The source whose copy lists `key`, with that channel. */
export function sourceOf(sources: readonly ChannelSource[], key: string): [ChannelSource, Channel] | null {
  for (const s of sources) {
    const c = s.view().channels.find((x) => x.key === key);
    if (c) return [s, c];
  }
  return null;
}

/** What a page gets: no sources, "locked" for a viewer who may not write (nothing is read for them), or every view. */
export const pageSources = (ss: readonly ChannelSource[], writer: boolean): SourceView[] | "locked" | null =>
  !ss.length ? null : !writer ? "locked" : ss.map((x) => ({ id: x.id, label: x.label, view: x.view() }));

/** A channel's name as the board shows it: `#name`, `DM · name`, or a thread as `#parent › name`. */
export const chanLabel = (c: Channel, d?: ChannelView): string => {
  if (c.kind === "dm") return `DM · ${c.name}`;
  const parent = c.parent ? d?.channels.find((p) => p.key === c.parent) : undefined;
  return c.kind === "thread" ? `${parent ? `#${parent.name} › ` : ""}${c.name}` : `#${c.name}`;
};

/** Every source's view merged into one, for what looks across sources (a project's talk). */
export const mergedView = (vs: readonly SourceView[]): ChannelView => ({
  channels: vs.flatMap((v) => v.view.channels),
  syncedAt: Math.max(0, ...vs.map((v) => v.view.syncedAt ?? 0)) || null,
  error: null,
  skipped: [],
});
