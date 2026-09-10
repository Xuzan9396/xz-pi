import assert from "node:assert/strict";
import { test } from "node:test";
import { planBatch } from "../src/policy.js";
import { childArgs } from "../src/runner.js";
import { resources } from "./helpers.js";

test("default read tasks and explicit write tools respect the parent capability ceiling", () => {
  assert.deepEqual(planBatch({ tasks: [{ name: "a", task: "inspect" }] }, resources)[0]?.tools, ["read", "grep", "find", "ls"]);
  const write = planBatch({ tasks: [{ name: "a", task: "inspect", mode: "write" }] }, resources)[0]!;
  assert.ok(write.tools.includes("mcp")); assert.ok(!write.tools.includes("xz_subagents_run"));
  assert.throws(() => planBatch({ tasks: [{ name: "a", task: "inspect", tools: ["mcp"] }] }, resources), /write/);
  assert.throws(() => planBatch({ tasks: [{ name: "a", task: "inspect", mode: "write", tools: ["xz_subagents_run"] }] }, resources), /delegation/);
  assert.throws(() => planBatch({ tasks: [{ name: "a", task: "inspect", tools: ["missing"] }] }, resources), /not active/);
});

test("exclusive controls scheduling only and defaults to false for both tool modes", () => {
  for (const mode of ["read", "write"] as const) {
    const task = { name: "a", task: "inspect", mode };
    const normal = planBatch({ tasks: [task] }, resources)[0]!;
    const exclusive = planBatch({ tasks: [{ ...task, exclusive: true }] }, resources)[0]!;
    assert.equal(normal.task.exclusive, false); assert.equal(exclusive.task.exclusive, true);
    assert.deepEqual(normal.tools, exclusive.tools);
  }
  assert.throws(() => planBatch({ tasks: [{ name: "a", task: "inspect", exclusive: "true" as unknown as boolean }] }, resources), /boolean/);
});

test("skills inherit when read is available and disable implicit inheritance without read", () => {
  const withSkills = { ...resources, skills: [{ name: "global", filePath: "/skills/global/SKILL.md" }, { name: "cli", filePath: "/elsewhere/cli.md" }] };
  const task = { name: "a", task: "inspect" };
  assert.equal(planBatch({ tasks: [task] }, withSkills)[0]?.skillPaths.length, 2);
  assert.deepEqual(planBatch({ tasks: [{ ...task, skills: ["cli"] }] }, withSkills)[0]?.skillPaths, ["/elsewhere/cli.md"]);
  assert.deepEqual(planBatch({ tasks: [{ ...task, tools: [] }] }, withSkills)[0]?.skillPaths, []);
  assert.deepEqual(planBatch({ tasks: [{ ...task, tools: [], skills: [] }] }, withSkills)[0]?.skillPaths, []);
  assert.throws(() => planBatch({ tasks: [{ ...task, tools: [], skills: ["cli"] }] }, withSkills), /read tool/);
  assert.throws(() => planBatch({ tasks: [{ ...task, skills: ["unknown"] }] }, withSkills), /not loaded/);

  const withoutRead = { ...withSkills, tools: withSkills.tools.filter(name => name !== "read") };
  assert.deepEqual(planBatch({ tasks: [task] }, withoutRead)[0]?.skillPaths, []);
});

test("operation and task-specific context are explicit", () => {
  const implementation = planBatch({ context: "shared", tasks: [{
    name: "writer", task: "implement", mode: "write", operation: "implement", context: "only src/api", skills: [],
  }] }, resources)[0]!;
  assert.match(implementation.context, /Shared batch context:\nshared/);
  assert.match(implementation.context, /Task-specific context:\nonly src\/api/);
  assert.throws(() => planBatch({ tasks: [{ name: "a", task: "implement", operation: "implement" }] }, resources), /mode: write/);
});

test("validation rejects duplicate/unsafe labels and invalid limits", () => {
  const task = { name: "a", task: "inspect" };
  assert.throws(() => planBatch({ tasks: [task, task] }, resources), /unique/);
  assert.throws(() => planBatch({ tasks: [{ ...task, name: "../bad" }] }, resources), /unique/);
  assert.throws(() => planBatch({ tasks: [] }, resources));
  assert.throws(() => planBatch({ tasks: [task], concurrency: 0 }, resources));
});

test("CLI arguments preserve trust, exact tool/skill lists and explicit extension paths", () => {
  const p = planBatch({ tasks: [{ name: "a", task: "inspect", tools: [], skills: [] }] }, { ...resources, extensions: ["/tmp/ext.ts"] })[0]!;
  const args = childArgs(p, "/private/prompt.md", "/pkg/child.ts");
  assert.ok(args.includes("--no-approve")); assert.ok(!args.includes("--approve"));
  assert.ok(args.includes("--no-tools")); assert.ok(args.includes("--no-skills"));
  assert.ok(!args.includes("--no-extensions")); assert.ok(args.includes("/tmp/ext.ts"));
  assert.ok(args.includes("/pkg/child.ts")); assert.ok(!args.some(arg => arg.includes("inspect")));
  p.resources = { ...p.resources, trusted: true };
  assert.ok(childArgs(p, "p", "e").includes("--approve"));
});
