import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { WorktreeService } from "../src/service.js";

const exec = promisify(execFile);
async function repository(t: { after(fn: () => unknown): void }) {
  const parent = await mkdtemp(join(tmpdir(), "xz-pi-worktree-test-"));
  const repo = join(parent, "repo");
  const stateRoot = join(parent, "state");
  await mkdir(repo);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await writeFile(join(repo, "file.txt"), "before\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  return { parent, repo, service: new WorktreeService({ stateRoot }) };
}

test("create, inspect, capture, apply and cleanup form a standalone lifecycle", async t => {
  const { repo, service } = await repository(t);
  const created = await service.create({ cwd: repo, name: "feature" });
  assert.equal(created.status, "created");
  assert.ok(existsSync(created.worktreePath));
  assert.equal((await service.list(repo)).length, 1);
  assert.equal((await service.status(created.id)).dirty, false);

  await writeFile(join(created.worktreePath, "file.txt"), "after\n");
  await writeFile(join(created.worktreePath, "new.txt"), "new\n");
  const captured = await service.capture(created.id);
  assert.deepEqual(captured.changedFiles, ["file.txt", "new.txt"]);
  assert.ok((await readFile(captured.patchPath)).length > 0);

  const applied = await service.apply(created.id);
  assert.equal(applied.status, "applied");
  assert.equal(existsSync(applied.worktreePath), false);
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "new\n");
});

test("remove protects changes unless force is explicit", async t => {
  const { repo, service } = await repository(t);
  const created = await service.create({ cwd: repo, name: "discard" });
  await writeFile(join(created.worktreePath, "dirty.txt"), "dirty\n");
  await assert.rejects(service.remove(created.id), /has changes/);
  assert.ok(existsSync(created.worktreePath));
  const removed = await service.remove(created.id, true);
  assert.equal(removed.status, "removed");
  assert.equal(existsSync(created.worktreePath), false);
});

test("apply fails closed and preserves worktree and patch when main is dirty", async t => {
  const { repo, service } = await repository(t);
  const created = await service.create({ cwd: repo, name: "conflict" });
  await writeFile(join(created.worktreePath, "file.txt"), "child\n");
  await writeFile(join(repo, "file.txt"), "parent\n");
  await assert.rejects(service.apply(created.id), /not applied/);
  const status = await service.status(created.id);
  assert.equal(status.status, "conflict");
  assert.ok(status.worktreeExists);
  assert.ok(existsSync(status.patchPath));
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "parent\n");
});

test("apply preserves work when the main HEAD changed", async t => {
  const { repo, service } = await repository(t);
  const created = await service.create({ cwd: repo, name: "stale-head" });
  await writeFile(join(created.worktreePath, "file.txt"), "child\n");
  await writeFile(join(repo, "main.txt"), "new head\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-qm", "advance"]);
  await assert.rejects(service.apply(created.id), /Main HEAD changed/);
  const status = await service.status(created.id);
  assert.equal(status.status, "conflict");
  assert.ok(status.worktreeExists);
});

test("create rejects dirty repositories and unsafe names", async t => {
  const { repo, service } = await repository(t);
  await writeFile(join(repo, "dirty.txt"), "dirty\n");
  await assert.rejects(service.create({ cwd: repo, name: "feature" }), /clean Git checkout/);
  await assert.rejects(service.create({ cwd: repo, name: "../bad" }), /Worktree name/);
});
