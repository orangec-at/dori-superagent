import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./loop-setup.ts";

const MIN = 60_000;
const URL = "https://github.com/orangec-at/team-board/issues";

type Issue = { number: number; title: string; createdAt: number; comments: { body: string; createdAt: number }[] };

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ghList = (issues: readonly Issue[]) =>
  JSON.stringify(
    issues.map((i) => ({
      ...i,
      url: `${URL}/${i.number}`,
      createdAt: iso(i.createdAt),
      comments: i.comments.map((c) => ({ author: { login: "orangec-at" }, body: c.body, createdAt: iso(c.createdAt) })),
    })),
  );

function board(issues: Issue[]) {
  const s = setup();
  const lists: (readonly string[])[] = [];
  s.w.gh = (argv) => {
    if (argv[0] !== "issue" || argv[1] !== "list") return { code: 1, stdout: "" };
    lists.push(argv);
    return { code: 0, stdout: ghList(issues) };
  };
  const loopMsgs = () => s.lead.received.filter((m) => m.startsWith("[LOOP"));
  return { ...s, lists, loopMsgs };
}

describe("hourly loop: team-board check", () => {
  test("reports a new issue and a bot comment, skips lead comments, and never repeats them", async () => {
    const issues: Issue[] = [];
    const { w, tick, lists, loopMsgs } = board(issues);
    const now = w.clock;
    issues.push(
      {
        number: 1,
        title: "[도리도라 전달 요청] old, lead answered",
        createdAt: now - 180 * MIN,
        comments: [{ body: "도리도라 회신: 이미 끝났어요", createdAt: now - 5 * MIN }],
      },
      {
        number: 2,
        title: "[도리도라→Muse] old, bot answered",
        createdAt: now - 180 * MIN,
        comments: [
          { body: "도리도라 기록 (2026-11-12)", createdAt: now - 6 * MIN },
          { body: "Muse: 계정 연결 확인했어요", createdAt: now - 4 * MIN },
        ],
      },
      { number: 3, title: "[도리도라 협의·제작 요청] new", createdAt: now - 10 * MIN, comments: [] },
    );

    const first = await tick();
    expect(first.board).toEqual([
      `board: #2 [도리도라→Muse] old, bot answered (새 댓글 1) ${URL}/2`,
      `board: #3 [도리도라 협의·제작 요청] new (새 이슈) ${URL}/3`,
    ]);
    expect(loopMsgs().at(-1)).toContain(`\nboard: #3 [도리도라 협의·제작 요청] new (새 이슈) ${URL}/3`);
    expect(lists[0]).toEqual([
      "issue",
      "list",
      "--repo",
      "orangec-at/team-board",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,createdAt,comments",
    ]);

    w.clock += 60 * MIN;
    expect((await tick()).board).toEqual([]);
    expect(loopMsgs().at(-1)).not.toContain("board:");

    issues[0]!.comments.push({ body: "도리도라 회신: 또 답했어요", createdAt: w.clock - 2 * MIN });
    issues[2]!.comments.push(
      { body: "홍붕이: 추가 요청", createdAt: w.clock - 3 * MIN },
      { body: "홍붕이: 하나 더", createdAt: w.clock - 1 * MIN },
    );
    w.clock += 60 * MIN;
    expect((await tick()).board).toEqual([`board: #3 [도리도라 협의·제작 요청] new (새 댓글 2) ${URL}/3`]);
  });

  test("a gh failure is one line, the run still reports, and nothing seen during the outage is lost", async () => {
    const issues: Issue[] = [];
    const { w, d, tick, loopMsgs } = board(issues);
    const ok = w.gh;
    issues.push({ number: 4, title: "while gh was down", createdAt: w.clock - 5 * MIN, comments: [] });
    w.gh = () => ({ code: 1, stdout: "HTTP 401: Bad credentials (https://api.github.com/graphql)\nmore" });

    const down = await tick();
    expect(down.board).toEqual(["board: 확인 실패 HTTP 401: Bad credentials (https://api.github.com/graphql)"]);
    expect(d.store.lastRun()!.at).toBe(down.at);
    expect(loopMsgs().at(-1)).toContain("\nboard: 확인 실패 HTTP 401");

    w.gh = () => ({ code: 0, stdout: "not json" });
    expect((await tick()).board![0]).toStartWith("board: 확인 실패 ");

    w.gh = ok;
    expect((await tick()).board).toEqual([`board: #4 while gh was down (새 이슈) ${URL}/4`]);
  });

  test("the repo comes from config.json boardRepo, and off turns the check off", async () => {
    const { d, tick, lists, loopMsgs } = board([]);
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ boardRepo: "acme/requests" }));
    await tick();
    expect(lists.at(-1)!.slice(0, 4)).toEqual(["issue", "list", "--repo", "acme/requests"]);

    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ boardRepo: "off" }));
    const before = lists.length;
    expect((await tick()).board).toEqual([]);
    expect(lists).toHaveLength(before);
    expect(loopMsgs().at(-1)).not.toContain("board:");
  });
});
