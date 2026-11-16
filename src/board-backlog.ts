import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { backlogAdd, backlogDecide, backlogDrop, backlogPriority } from "./backlog.ts";
import { projectAliases, projectResolver, projectSeeds, type Subject } from "./board-projects.ts";
import { lanePrs } from "./board-prs.ts";
import { Refusal } from "./refusal.ts";
import type { Store } from "./store.ts";

type Reject = (code: string, why: string, status: number) => Response;
type Out = { reject: Reject; log: (line: string) => void; headers: Record<string, string> };

const TITLE_MAX = 200;
const TEXT_MAX = 2000;
const ACTIONS = new Set(["add", "priority", "drop", "decide"]);

/** A lane-key-safe stem: lowercase ASCII, a letter first. */
const stem = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 30)
    .replace(/-+$/, "");

/**
 * Where a new item of `project` goes so the board places it there: the cwd of the project's newest work, and an id
 * that starts with the project's key prefix (else one of its words, else its name) and ends with a time stamp. null
 * when no such item would be placed in the project (it would show elsewhere).
 */
export function placement(store: Store, project: string, now: number): { id: string; cwd: string } | null {
  const seeds = projectSeeds(store.root);
  const aliases = projectAliases(store.root);
  const work: (Subject & { at: number })[] = [
    ...store.lanes().map((l) => ({
      key: l.key,
      cwd: l.cwd,
      repos: lanePrs(l).flatMap((p) => (p.repo ? [p.repo] : [])),
      at: l.lastActivityAt,
    })),
    ...store.items().map((i) => ({ key: i.id, cwd: i.cwd, repos: [], title: i.title, at: i.updatedAt })),
  ];
  const place = projectResolver(seeds, aliases, work);
  const mine = work.filter((w) => place(w) === project).sort((a, b) => b.at - a.at);
  const seed = seeds.find((p) => p.name === project);
  if (!mine.length && !seed) return null;
  const base =
    [...(seed?.prefixes ?? []), ...(seed?.words ?? []), project, ...mine.map((w) => w.key.split("-")[0] ?? "")]
      .map(stem)
      .find((x) => x.length >= 2) ?? "task";
  const id = `${base}-${now.toString(36).slice(-6)}`;
  const cwd = mine[0]?.cwd ?? homedir();
  const added: Subject = { key: id, cwd, repos: [] };
  return projectResolver(seeds, aliases, [...work, added])(added) === project ? { id, cwd } : null;
}

/**
 * POST /backlog, reached only after the board's writer, origin and CSRF checks passed: adds a task to a project's
 * backlog, changes an open item's priority, answers its decision or drops it, through the same functions as
 * `dori backlog`, and returns to the project's tasks. A refused edit (unknown item, item no longer open) answers 409.
 */
export function backlogPost(store: Store, now: number, form: URLSearchParams, o: Out): Response {
  const action = form.get("action") ?? "";
  const project = (form.get("p") ?? "").trim();
  const id = form.get("id") ?? "";
  const text = (form.get("text") ?? "").trim();
  if (!ACTIONS.has(action)) return o.reject("action", "unknown backlog action", 400);
  if (project === "" || project.length > TITLE_MAX) return o.reject("project", "unknown project", 400);
  if (text.length > TEXT_MAX) return o.reject("length", `text longer than ${TEXT_MAX} characters`, 413);
  const d = { store, now: () => now };
  let done = id;
  try {
    if (action === "add") {
      const title = (form.get("title") ?? "").trim();
      if (title === "") return o.reject("empty", "empty title", 400);
      if (title.length > TITLE_MAX) return o.reject("length", `title longer than ${TITLE_MAX} characters`, 413);
      const at = placement(store, project, now);
      if (!at)
        return o.reject("place", `no place for a new item of ${project}; add it with dori backlog add --cwd`, 409);
      const brief = store.loopPath(`board-add-${at.id}.md`);
      writeFileSync(brief, `# ${title}\n\n${text ? `${text}\n\n` : ""}(보드에서 추가 · 프로젝트 ${project})\n`);
      try {
        backlogAdd(d, at.id, brief, {
          title,
          cwd: at.cwd,
          priority: Number(form.get("priority") ?? "5"),
          source: "board",
        });
      } finally {
        rmSync(brief, { force: true });
      }
      done = at.id;
    } else if (action === "priority") backlogPriority(d, id, Number(form.get("priority")));
    else if (action === "drop") backlogDrop(d, id, "보드에서 드롭");
    else if (text === "") return o.reject("empty", "empty answer", 400);
    else backlogDecide(d, id, text);
  } catch (e) {
    if (e instanceof Refusal) return o.reject("backlog", e.message, 409);
    throw e;
  }
  o.log(`BOARD_BACKLOG ${action} ${done}`);
  return new Response(null, {
    status: 303,
    headers: { location: `/?tab=proj&p=${encodeURIComponent(project)}&sent=backlog#tasks`, ...o.headers },
  });
}
