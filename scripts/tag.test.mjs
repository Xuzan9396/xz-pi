import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpVersion,
  hasReachedVersion,
  highestBump,
  parseChangeset,
  removePackagesFromChangeset,
  renderChangeset,
  waitForPublishedVersions,
} from "./tag.mjs";

test("中文版本选项使用标准 SemVer 计算目标版本", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(bumpVersion("0.1.0", "major"), "1.0.0");
  assert.equal(highestBump("patch", "major"), "major");
});

test("判断 npm 版本是否达到预计版本", () => {
  assert.equal(hasReachedVersion("0.2.0", "0.2.0"), true);
  assert.equal(hasReachedVersion("0.2.1", "0.2.0"), true);
  assert.equal(hasReachedVersion("0.1.9", "0.2.0"), false);
  assert.equal(hasReachedVersion(null, "0.2.0"), false);
});

test("等待 npm 版本时允许多次查询", async () => {
  const versions = ["0.1.0", "0.2.0"];
  const result = await waitForPublishedVersions(
    [{ name: "xz-pi-vim", version: "0.2.0" }],
    {
      lookupVersion: () => versions.shift(),
      maxAttempts: 2,
      intervalMs: 0,
      sleep: async () => {},
    },
  );
  assert.equal(result.get("xz-pi-vim"), "0.2.0");
});

test("等待 npm 版本超时后给出期望和当前版本", async () => {
  await assert.rejects(
    waitForPublishedVersions(
      [{ name: "xz-pi-vim", version: "0.2.0" }],
      { lookupVersion: () => "0.1.0", maxAttempts: 1, intervalMs: 0 },
    ),
    /xz-pi-vim（期望 0\.2\.0，当前 0\.1\.0）/,
  );
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
