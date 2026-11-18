import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOffTask, parseRoadmap, personOnly, taskId } from "../src/roadmap.ts";
import { COUPAS } from "./autopilot-setup.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

describe("project roadmaps", () => {
  test("parse fields, milestones and tasks; person-only work is marked, a forbidding clause is not", () => {
    const r = parseRoadmap("coupas", "/x/coupas.md", COUPAS, 5);
    expect(r).toMatchObject({ title: "쿠파스", goal: "쿠팡 파트너스 글·영상", owners: ["hongbungi", "bido"] });
    expect(r.keywords).toEqual(["coupas", "쿠파스"]);
    expect(r.milestones).toEqual(["11월: 게시 큐 20개"]);
    expect(r.tasks.map((t) => [t.done, t.kind, t.bot, t.blocked])).toEqual([
      [true, "delegate", undefined, undefined],
      [false, "delegate", undefined, undefined],
      [false, "delegate", undefined, "게시"],
      [false, "delegate", "bido", undefined],
    ]);
    expect(parseRoadmap("p", "f", "## 다음 할 일\n- [ ] [pr] 인덱스 정리\n", 0).tasks[0]!.kind).toBe("pr");
  });

  test("checkOffTask flips one character of the one matching line; checked, duplicate or edited lines are not written", () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-test-roadmap-"));
    const file = join(dir, "p.md");
    const text = "# p\n  * [ ] 한글   메모\n- [ ] [pr] 인덱스\n- [X] 끝난 일\n- [ ] 같은 일\n- [ ] 같은 일";
    writeFileSync(file, text);
    chmodSync(file, 0o640);
    const link = join(dir, "link.md");
    symlinkSync(file, link);
    expect(checkOffTask(link, "p", taskId("p", "한글   메모"))).toBe("checked");
    expect(readFileSync(file, "utf8")).toBe(text.replace("* [ ]", "* [x]"));
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const after = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    expect(checkOffTask(file, "p", taskId("p", "끝난 일"))).toBe("already");
    expect(checkOffTask(file, "p", taskId("p", "같은 일"))).toBe("conflict");
    expect(checkOffTask(file, "p", taskId("p", "인덱스"))).toBe("conflict");
    expect(checkOffTask(file, "p", taskId("p", "없는 일"))).toBe("conflict");
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  test("person-only words match whole English words; a request after '하지 말고' still counts", () => {
    expect(["total 지표", "quota 표", "rotate 문서"].map(personOnly)).toEqual([undefined, undefined, undefined]);
    expect(personOnly("OTA로 내보내기")).toBe("배포");
    expect(personOnly("게시하지 말고 머지해")).toBe("병합");
    expect(personOnly("게시·Muse 전달은 하지 마")).toBe("게시");
    expect(personOnly("블로그 게시하고 반응이 좋지 않으면 알려줘")).toBe("게시");
    expect(personOnly("배포하고 문제가 없지 않으면 보고")).toBe("배포");
    expect(["main에 push해", "git push --force", "force-push the branch"].map(personOnly)).toEqual([
      "병합",
      "병합",
      "병합",
    ]);
    expect(["push 알림 문구 초안", "푸시 알림 카피 3안", "배포 금지"].map(personOnly)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const asked = ["블로그에 올려", "인스타에 포스팅", "스레드에 글 올리기", "앱스토어 제출", "published the post"];
    expect(asked.map(personOnly)).toEqual(["게시", "게시", "게시", "게시", "게시"]);
    expect(["deploying it", "merging the PR"].map(personOnly)).toEqual(["배포", "병합"]);
    expect(personOnly("don't forget to publish the post")).toBe("게시");
    expect(personOnly("배포 금지 해제하고 배포")).toBe("배포");
    expect(personOnly("don't publish, just draft")).toBeUndefined();
    expect(parseRoadmap("p", "f", "- 담당: endo, -oProxy, a b\n", 0).owners).toEqual(["endo"]);
  });
});
