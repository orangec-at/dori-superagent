import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup as base } from "./harness-setup.ts";

export const HOUR = 3_600_000;
export const NOON_KST = Date.parse("2026-11-16T03:00:00Z");
export const COUPAS = `# 쿠파스
- 목표: 쿠팡 파트너스 글·영상
- 담당: hongbungi, bido
- 키워드: 쿠파스
- 완료 기준: 주 5개 초안

## 마일스톤
- 11월: 게시 큐 20개

## 다음 할 일
- [x] 첫 상품 3개 초안
- [ ] 다음 주 후보 5개 초안. 게시는 하지 마
- [ ] 스레드에 게시
- [ ] @bido 쇼츠 검토본 1개
`;

const agent = (name: string) => ({ name, host: "", profile: name, role: "", description: "" });
const iso = (ms: number) => new Date(ms).toISOString();

export function setup(roadmaps: Record<string, string>, editedAgo = HOUR, bots = ["hongbungi", "bido"]) {
  const s = base();
  s.w.clock = NOON_KST;
  const home = s.d.store.root;
  writeFileSync(join(home, "agents.json"), JSON.stringify(bots.map(agent)));
  mkdirSync(join(home, "projects"));
  for (const [name, text] of Object.entries(roadmaps)) {
    const file = join(home, "projects", `${name}.md`);
    writeFileSync(file, text);
    utimesSync(file, (NOON_KST - editedAgo) / 1000, (NOON_KST - editedAgo) / 1000);
  }
  const launched: { bot: string; text: string; mission: string | undefined }[] = [];
  const launch = (bot: string, text: string, mission?: string) => launched.push({ bot, text, mission });
  const run = (agentName: string, at: number, end?: number, text = "쿠파스 일", outcome = "ok") => {
    const line = { at: iso(at), agent: agentName, text, until: iso(at + 600_000) };
    writeFileSync(join(home, "delegate-runs.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
    if (end !== undefined)
      writeFileSync(join(home, "delegations.jsonl"), `${JSON.stringify({ ...line, outcome, endedAt: iso(end) })}\n`, {
        flag: "a",
      });
  };
  return { ...s, home, launched, launch, run };
}
