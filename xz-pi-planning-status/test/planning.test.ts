import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseLatestCurrentPlan } from "../src/planning.js";

const state = `# XZ Planning State

## 当前进度

| 版本 | 需求 | 讨论 | 状态 |
|------|------|------|------|
| 35.3 | 较早计划 | | ✅ 已完成 |
| 36 | TG机器人加安全额度申请交互命令 | | ✅ 已完成 |
| 35.10 | 中间计划 | | ✅ 已完成 |

## 已归档

| 版本 | 需求 |
|------|------|
| 99 | 不应读取的归档计划 |
`;

test("prefers the numerically latest plan from 当前进度", () => {
  assert.deepEqual(parseLatestCurrentPlan(state), {
    version: "36",
    requirement: "TG机器人加安全额度申请交互命令",
  });
});

test("falls back to the numerically latest archived plan when 当前进度 is empty", () => {
  const markdown = `## 当前进度
| 版本 | 需求 |
| --- | --- |

## 已归档
| 版本 | 需求 | 完成时间 |
| --- | --- | --- |
| 9 | 较早归档 | 2026-01-01 |
| 11 | 最新归档 | 2026-01-03 |
| 10 | 中间归档 | 2026-01-02 |
`;
  assert.deepEqual(parseLatestCurrentPlan(markdown), { version: "11", requirement: "最新归档" });
});

test("reads 已归档 when 当前进度 is absent or invalid", () => {
  const archived = `## 已归档
| 需求 | 版本 |
| --- | --- |
| 已归档需求 | 12.1 |
`;
  assert.deepEqual(parseLatestCurrentPlan(archived), { version: "12.1", requirement: "已归档需求" });
  assert.deepEqual(parseLatestCurrentPlan(`## 当前进度\nnot a table\n\n${archived}`), {
    version: "12.1",
    requirement: "已归档需求",
  });
});

test("supports reordered columns and escaped pipes", () => {
  const markdown = `## 当前进度
| 需求 | 版本 |
| --- | --- |
| 支持\\|字符 | 36.1 |
`;
  assert.deepEqual(parseLatestCurrentPlan(markdown), { version: "36.1", requirement: "支持|字符" });
});

test("returns null when the file cannot be parsed", () => {
  assert.equal(parseLatestCurrentPlan("# no current progress"), null);
  assert.equal(parseLatestCurrentPlan("## 当前进度\nnot a table"), null);
  assert.equal(parseLatestCurrentPlan("## 当前进度\n| 版本 | 需求 |\n|---|---|\n| latest | bad |"), null);
});

test("compares dotted numeric versions naturally", () => {
  assert.ok(compareVersions("35.10", "35.3") > 0);
  assert.ok(compareVersions("36", "35.10") > 0);
  assert.equal(compareVersions("36", "36.0"), 0);
});
