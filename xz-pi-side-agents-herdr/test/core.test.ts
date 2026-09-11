import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgentArgs } from "../index.js";
import { mapHerdrStatus } from "../src/herdr.js";
import { choosePlacement } from "../src/layout.js";
import { cleanupBlockers } from "../src/lifecycle.js";
import { featureSlug, nextIdentity } from "../src/naming.js";
import { buildBootstrapCommand } from "../src/service.js";
import { Store } from "../src/store.js";

test("agent command keeps pi-side-agents model and mode syntax", () => {
  assert.deepEqual(parseAgentArgs("-model openai/gpt-5 fix auth"), { task: "fix auth", model: "openai/gpt-5", mode: undefined });
  assert.deepEqual(parseAgentArgs("review api -mode deep"), { task: "review api", model: undefined, mode: "deep" });
});

test("feature names are safe for Herdr agent names", () => {
  assert.equal(featureSlug("Fix Auth / Login"), "fix-auth-login");
  assert.equal(featureSlug("123 task"), "task-123-task");
  assert.ok(featureSlug("a".repeat(100)).length <= 22);
});

test("identity includes feature and a four digit number", () => {
  const root = join("/tmp", "repo");
  const first = nextIdentity(root, "fix-auth", { version: 1, agents: {} }, []);
  assert.equal(first.id, "fix-auth-0001");
  assert.equal(first.branch, "side-agent/fix-auth-0001");
  assert.equal(first.worktreePath, join("/tmp", "repo-agent-fix-auth-0001"));
  const second = nextIdentity(root, "fix-auth", { version: 1, agents: { [first.id]: {} as never } }, []);
  assert.equal(second.id, "fix-auth-0002");
  const branchCollision = nextIdentity(root, "fix-auth", { version: 1, agents: {} }, [], ["side-agent/fix-auth-0001"]);
  assert.equal(branchCollision.id, "fix-auth-0002");
});

test("bootstrap wait token cannot match the shell's echoed command early", () => {
  const marker = "__BOOT_TEST__";
  const command = buildBootstrapCommand("/tmp/start.sh", "/tmp/repo", "/tmp/wt", "agent-1", marker);
  assert.equal(command.includes(`${marker}:`), false);
  assert.match(command, /printf .*%s:%s/);
});

test("layout keeps main largest and stacks children on the right", () => {
  const panes = [
    { pane_id: "main", rect: { x: 0, y: 0, width: 140, height: 80 } },
    { pane_id: "child-1", rect: { x: 140, y: 0, width: 50, height: 50 } },
    { pane_id: "child-2", rect: { x: 140, y: 50, width: 50, height: 30 } },
  ];
  assert.deepEqual(choosePlacement("main", [panes[0]], [], 0.72, 0.5), { targetPaneId: "main", direction: "right", ratio: 0.72 });
  assert.deepEqual(choosePlacement("main", panes, ["child-1", "child-2"], 0.72, 0.5), { targetPaneId: "child-1", direction: "down", ratio: 0.5 });
});

test("quit cleanup blocks uncommitted and unmerged work", () => {
  assert.deepEqual(cleanupBlockers("", 0, "main"), []);
  assert.deepEqual(cleanupBlockers(" M file.ts", 0, "main"), ["存在未提交修改"]);
  assert.deepEqual(cleanupBlockers("", 2, "develop"), ["有 2 个提交尚未合并到 develop"]);
});

test("Herdr statuses map to the stable orchestration states", () => {
  assert.equal(mapHerdrStatus("working"), "running");
  assert.equal(mapHerdrStatus("idle"), "waiting_user");
  assert.equal(mapHerdrStatus("done"), "waiting_user");
  assert.equal(mapHerdrStatus("blocked"), "blocked");
  assert.equal(mapHerdrStatus("unknown"), undefined);
});

test("registry mutations persist atomically", async t => {
  const root = await mkdtemp(join(tmpdir(), "xz-herdr-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.mutate(registry => { registry.agents.one = { id: "one" } as never; });
  assert.equal((await store.load()).agents.one.id, "one");
});
