import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { officeLive } from "../src/board-lead-live.ts";
import { type BotLive, LIVE_WORD, type LiveStatus } from "../src/board-live.ts";
import { officeTab } from "../src/board-office-html.ts";
import {
  dualMembers,
  type OfficeTeam,
  officeTeams,
  teamPairs,
  teamRooms,
  teamsLog,
  teamsState,
} from "../src/board-office-teams.ts";
import { NOW, start, tailnet } from "./board-setup.ts";

const DAY = 86_400_000;
const AGENTS = [
  ["gibungi", "기붕이", "fedora"],
  ["dido", "디도", "mini"],
  ["endo", "엔도", "fedora"],
  ["bido", "비도", "fedora"],
  ["hongbungi", "홍붕이", "ubuntu"],
  ["yoridori", "요리도리", "fedora"],
] as const;
const TEAMS = [
  { id: "dh-plan", name: "드로우하타 기획·디자인", members: ["gibungi", "dido", "endo"], note: "보경 님 스레드" },
  { id: "coupas", name: "쿠파스 영상·글", members: ["bido", "hongbungi", "endo"] },
];
const bot = (name: string, status: LiveStatus = "idle", o: Partial<BotLive> = {}): BotLive => ({
  name,
  label: AGENTS.find(([n]) => n === name)?.[1] ?? name,
  machine: AGENTS.find(([n]) => n === name)?.[2] ?? "fedora",
  task: null,
  status,
  word: LIVE_WORD[status],
  at: null,
  running: 0,
  ...o,
});
const team = (id: string, members: string[]): OfficeTeam => ({ id, name: id, members, note: null });

function home(board: unknown, lines: object[] | null = []) {
  const s = start();
  writeFileSync(
    join(s.home, "agents.json"),
    JSON.stringify(
      AGENTS.map(([name, label, m]) => ({
        name,
        host: "",
        profile: name,
        role: "r",
        description: `${label}(${m}): x`,
      })),
    ),
  );
  if (board !== undefined) writeFileSync(join(s.home, "board.json"), JSON.stringify(board));
  if (lines) writeFileSync(join(s.home, "delegations.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  return s;
}

test("office.teams is read; an entry without a name, with members not a list or naming an unknown bot is skipped", () => {
  const known = AGENTS.map(([n]) => n);
  const s = home({
    office: {
      teams: [
        TEAMS[0],
        { id: "x", members: ["bido"] },
        { id: "y", name: "목록 아님", members: "bido" },
        { id: "z", name: "모르는 봇", members: ["bido", "ghost"] },
        { name: "  조사  ", members: ["yoridori", "yoridori"] },
        { id: "dh-plan", name: "같은 id", members: ["bido"] },
        null,
      ],
    },
  });
  expect(officeTeams(s.home, known)).toEqual([
    { id: "dh-plan", name: "드로우하타 기획·디자인", members: ["gibungi", "dido", "endo"], note: "보경 님 스레드" },
    { id: "team-5", name: "조사", members: ["yoridori"], note: null },
  ]);
  expect(officeTeams(home(undefined).home, known)).toEqual([]);
  expect(officeTeams(home({ office: { remotes: [] } }).home, known)).toEqual([]);
  expect(officeTeams(home({ office: { teams: {} } }).home, known)).toEqual([]);
});

test("teams split into rooms: leads on top, a bot in two teams in both (겸임), the bots in none in 팀 없음", () => {
  const bots = [bot("lead", "working", { row: "lead" }), ...AGENTS.map(([n]) => bot(n))];
  const rooms = teamRooms(
    bots,
    TEAMS.map((t) => team(t.id, t.members)),
  );
  expect(rooms.lead.map((b) => b.name)).toEqual(["lead"]);
  expect(rooms.teams.map((r) => [r.team.id, r.bots.map((b) => b.name)])).toEqual([
    ["dh-plan", ["gibungi", "dido", "endo"]],
    ["coupas", ["endo", "bido", "hongbungi"]],
  ]);
  expect(rooms.none.map((b) => b.name)).toEqual(["yoridori"]);
  expect([...dualMembers(TEAMS.map((t) => team(t.id, t.members)))]).toEqual(["endo"]);
});

test("pairs: work given to a member that names a teammate, in the 7 days up to now, same team only, never itself", () => {
  const words = new Map(AGENTS.map(([n, l]) => [n, [n, l]] as const));
  const teams = TEAMS.map((t) => team(t.id, t.members));
  const g = (agent: string, text: string, ago: number) => ({ agent, text, at: NOW - ago });
  const pairs = teamPairs(
    [
      g("gibungi", "디도가 만든 시안을 봐 줘", DAY),
      g("dido", "기붕이 기획서대로", 2 * DAY),
      g("dido", "Gibungi's notes, endo 검토", 3 * DAY),
      g("gibungi", "디도 시안, 8일 전", 8 * DAY),
      g("gibungi", "디도 시안, 아직 안 온 일", -1),
      g("gibungi", "기붕이 혼자 정리", DAY),
      g("gibungi", "비도 영상", DAY),
      g("yoridori", "디도 시안", DAY),
      g("gibungi", "vendor bundle", DAY),
      g("bido", "홍붕이 글과 엔도 검수", DAY),
    ],
    teams,
    words,
    NOW,
  );
  expect(pairs["dh-plan"]).toEqual({ total: 4, top: { a: "gibungi", b: "dido", n: 3 } });
  expect(pairs["coupas"]).toEqual({ total: 2, top: { a: "bido", b: "hongbungi", n: 1 } });
  expect(teamPairs([], teams, words, NOW)["coupas"]).toEqual({ total: 0, top: null });
});

test("without office.teams the tab is exactly as before, by=team or not, and has no switch", async () => {
  const s = home(undefined);
  const live = await officeLive(s.store, NOW);
  expect(live.teams).toEqual({ teams: [], pairs: null, failed: null });
  const plain = officeTab({ generatedAt: NOW, bots: live.bots }, {});
  expect(officeTab(live, {}, true)).toBe(plain);
  expect(officeTab(live, {}, false)).toBe(plain);
  expect(plain).not.toContain("ofby");
  expect(plain).not.toContain("data-team");
});

test("the 팀별 view: a room per team with its count and pair line, 겸임 and the machine on each desk, no text leaks", async () => {
  const at = new Date(NOW - DAY).toISOString();
  const s = home({ office: { teams: TEAMS } }, [
    { at, agent: "gibungi", text: "디도 시안 <비밀 경로>", outcome: "ok" },
    { at, agent: "gibungi", text: "디도와 엔도 확인", outcome: "ok" },
  ]);
  const live = await officeLive(s.store, NOW);
  const html = officeTab(live, {}, true);
  expect(html).toContain('<a class="on" aria-current="page" href="/?tab=office&amp;by=team">팀별</a>');
  expect(html).toContain('<section class="room" data-team="lead">');
  expect(html).toContain(
    'data-team="dh-plan" title="보경 님 스레드"><header class="wall"><b>드로우하타 기획·디자인</b><span>3명</span>',
  );
  expect(html).toContain('<p class="pairs">최근 7일 주고받은 일 3건<br>기붕이·디도 2</p>');
  expect(html).toContain('<p class="pairs">최근 7일 주고받은 일 0건</p>');
  expect(html.match(/<em class="dual">겸임<\/em>/g)).toHaveLength(2);
  expect(html).toContain('<span class="mc">Mac mini</span>');
  expect(html).toContain('<section class="room" data-team="none"><header class="wall"><b>팀 없음</b><span>봇 1</span>');
  expect(html.indexOf('data-team="lead"')).toBeLessThan(html.indexOf('data-team="dh-plan"'));
  expect(html.indexOf('data-team="coupas"')).toBeLessThan(html.indexOf('data-team="none"'));
  expect(html).not.toContain("비밀");
  const byMachine = officeTab(live, {}, false);
  expect(byMachine).toContain('<a class="on" aria-current="page" href="/?tab=office">머신별</a>');
  expect(byMachine).toContain('data-machine="fedora"');
  expect(byMachine).not.toContain('class="mc"');
});

test("an unreadable delegations.jsonl drops only the pair lines and is one log line per new reason", async () => {
  const s = home({ office: { teams: TEAMS } }, null);
  const t = teamsState(s.home, NOW);
  expect(t.pairs).toBeNull();
  expect(t.failed).toContain("delegations.jsonl unreadable");
  const html = officeTab(await officeLive(s.store, NOW), {}, true);
  expect(html).toContain('data-team="dh-plan"');
  expect(html).not.toContain('class="pairs"');
  const lines: string[] = [];
  const log = teamsLog((l) => lines.push(l));
  for (const why of [t.failed, t.failed, null, t.failed]) log(why);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("BOARD_OFFICE_TEAMS delegations.jsonl unreadable");
});

test("the board serves ?tab=office&by=team with the team rooms", async () => {
  const s = home({ office: { teams: TEAMS } });
  const html = await (await fetch(`${s.url}/?tab=office&by=team`, { headers: tailnet() })).text();
  expect(html).toContain('data-team="coupas"');
  expect(html).toContain('href="/?tab=office">머신별</a>');
  const plain = await (await fetch(`${s.url}/?tab=office`, { headers: tailnet() })).text();
  expect(plain).toContain('<section class="room" data-machine="fedora">');
  expect(plain).not.toContain('data-team="coupas"');
});
