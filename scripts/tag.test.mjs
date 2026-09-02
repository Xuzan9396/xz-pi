import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpVersion,
  highestBump,
  parseChangeset,
  removePackagesFromChangeset,
  renderChangeset,
} from "./tag.mjs";

test("中文版本选项使用标准 SemVer 计算目标版本", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(bumpVersion("0.1.0", "major"), "1.0.0");
  assert.equal(highestBump("patch", "major"), "major");
});

test("解析并生成支持多个包的 Changeset", () => {
  const content = renderChangeset(
    [
      { name: "xz-pi-btw", bump: "minor" },
      { name: "xz-pi-vim", bump: "patch" },
    ],
    "增加中文发布助手。",
  );
  assert.deepEqual(parseChangeset(content), {
    releases: [
      { name: "xz-pi-btw", bump: "minor" },
      { name: "xz-pi-vim", bump: "patch" },
    ],
    summary: "增加中文发布助手。",
  });
});

test("重新选择版本时从旧 Changeset 移除目标包并保留其他包", () => {
  const original = `---\n"xz-pi-btw": major\n"xz-pi-vim": patch\n---\n\n旧说明\n`;
  const result = removePackagesFromChangeset(original, new Set(["xz-pi-btw"]));
  assert.equal(result.changed, true);
  assert.deepEqual(parseChangeset(result.content), {
    releases: [{ name: "xz-pi-vim", bump: "patch" }],
    summary: "旧说明",
  });
});

test("旧 Changeset 只包含被替换包时应删除", () => {
  const result = removePackagesFromChangeset(
    `---\n"xz-pi-btw": major\n---\n\n旧说明\n`,
    new Set(["xz-pi-btw"]),
  );
  assert.deepEqual(result, { changed: true, content: null });
});
