import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { captureTaskWorktree, integrateTaskWorktrees, prepareTaskWorktree } from "../src/worktree.js";
import { plan, record } from "./helpers.js";

const exec = promisify(execFile);
async function repository(t: { after(fn: () => unknown): void }) {
  const parent = await mkdtemp(join(tmpdir(), "xz-worktree-test-"));
  const repo = join(parent, "repo"); await mkdir(repo);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await writeFile(join(repo, "file.txt"), "before\n");
  await exec("git", ["-C", repo, "add", "."]); await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  return { parent, repo };
}
function isolatedPlan(repo: string) {
  const p = plan("writer", "write");
  p.resources = { ...p.resources, cwd: repo };
  p.task = { ...p.task, operation: "implement", isolation: "worktree", requireChanges: true };
  return p;
}
function isolatedRecord() {
  const r = record("writer");
  r.mode = "write"; r.operation = "implement"; r.isolation = "worktree"; r.requireChanges = true;
  return r;
}

test("worktree changes are captured, applied serially and cleaned after success", async t => {
  const { parent, repo } = await repository(t);
  const artifacts = join(parent, "artifacts"); await mkdir(artifacts);
  const p = isolatedPlan(repo); const r = isolatedRecord(); r.artifactDir = artifacts;
  await prepareTaskWorktree(p, r);
  assert.match(r.worktree?.worktreePath ?? "", /\.xz-pi-worktrees\/repo-writer-/);
  await writeFile(join(r.worktree!.worktreePath, "file.txt"), "after\n");
  await writeFile(join(r.worktree!.worktreePath, "new.txt"), "new\n");
  await captureTaskWorktree(r);
  r.status = "completed";
  await integrateTaskWorktrees([p], [r], () => {});
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "new\n");
  assert.equal(r.worktree?.integration, "applied");
  assert.equal(existsSync(r.worktree!.worktreePath), false);
  assert.match(await readFile(r.worktree!.handoffPath, "utf8"), /"integration": "applied"/);
  assert.match(await readFile(join(artifacts, "result.json"), "utf8"), /"integration": "applied"/);
});

test("integration conflicts fail closed and preserve the worktree and patch", async t => {
  const { parent, repo } = await repository(t);
  const artifacts = join(parent, "artifacts"); await mkdir(artifacts);
  const p = isolatedPlan(repo); const r = isolatedRecord(); r.artifactDir = artifacts;
  await prepareTaskWorktree(p, r);
  await writeFile(join(r.worktree!.worktreePath, "file.txt"), "child\n");
  await captureTaskWorktree(r);
  await writeFile(join(repo, "file.txt"), "parent\n");
  r.status = "completed";
  await integrateTaskWorktrees([p], [r], () => {});
  assert.equal(r.status, "failed"); assert.equal(r.worktree?.integration, "conflict");
  assert.equal(existsSync(r.worktree!.worktreePath), true);
  assert.equal(existsSync(r.worktree!.patchPath), true);
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "parent\n");
});

test("strict worktree setup rejects a dirty main checkout", async t => {
  const { parent, repo } = await repository(t);
  await writeFile(join(repo, "dirty.txt"), "dirty\n");
  const p = isolatedPlan(repo); const r = isolatedRecord(); r.artifactDir = join(parent, "artifacts"); await mkdir(r.artifactDir);
  await assert.rejects(prepareTaskWorktree(p, r), /clean main Git checkout/);
});
