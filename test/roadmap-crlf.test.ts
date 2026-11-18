import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOffTask, parseRoadmap, taskId } from "../src/roadmap.ts";
import { AUTOPILOT_ENV, pinEnv } from "./env-pin.ts";

pinEnv(AUTOPILOT_ENV);

describe("project roadmaps saved with CRLF", () => {
  test("crlf_tasks_parse_without_carriage_return_and_check_off_keeps_crlf", () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-test-roadmap-"));
    const file = join(dir, "p.md");
    const text = "# p\r\n- 담당: endo\r\n\r\n## 다음 할 일\r\n- [ ] 메모\r\n- [X] 끝난 일\r\n- [ ] [pr] 인덱스\r\n";
    writeFileSync(file, text);
    try {
      const r = parseRoadmap("p", file, text, 0);
      expect(r.tasks.map((t) => [t.text, t.done, t.kind])).toEqual([
        ["메모", false, "delegate"],
        ["끝난 일", true, "delegate"],
        ["인덱스", false, "pr"],
      ]);
      expect([r.title, r.owners]).toEqual(["p", ["endo"]]);
      expect(r.tasks[0]!.id).toBe(taskId("p", "메모"));
      expect(checkOffTask(file, "p", taskId("p", "메모"))).toBe("checked");
      expect(readFileSync(file, "utf8")).toBe(text.replace("- [ ] 메모", "- [x] 메모"));
      expect(checkOffTask(file, "p", taskId("p", "끝난 일"))).toBe("already");
      expect(checkOffTask(file, "p", taskId("p", "인덱스"))).toBe("conflict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
