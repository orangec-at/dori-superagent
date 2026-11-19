import { describe, expect, test } from "bun:test";
import { personOnly } from "../src/roadmap.ts";

describe("personOnly false positives", () => {
  test.each([
    "나머지는 그대로 두고 첫 문단만 다듬기",
    "나머지 문장은 그대로 유지",
    "README 나머지 섹션 번역",
    "머지않아 정리할 문서 목록",
    "머지않은 시기에 다시 볼 메모",
    "게시·발행·배포 금지",
    "초안만 쓰기. 게시·발송·병합 금지",
    "업로드·게시는 하지 마, 초안만 정리",
  ])("요청이 아님: %s", (text) => {
    expect(personOnly(text)).toBeUndefined();
  });

  test.each([
    ["PR 머지해", "병합"],
    ["나머지 정리하고 main에 머지", "병합"],
    ["머지않아 끝나면 PR 머지", "병합"],
    ["게시·배포 진행", "게시"],
    ["게시·Muse 전달은 하지 마", "게시"],
    ["게시하고 배포·병합 금지", "게시"],
    ["배포 금지 해제하고 블로그 게시·공유", "게시"],
  ])("계속 요청: %s", (text, label) => {
    expect(personOnly(text)).toBe(label);
  });
});
