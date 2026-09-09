import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LaunchPlan, TaskRecord, WorktreeHandoff } from "./types.js";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${String(stderr).trim() ? `\n${String(stderr).trim()}` : ""}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function persistHandoff(handoff: WorktreeHandoff): Promise<void> {
  await writeFile(handoff.handoffPath, JSON.stringify(handoff, null, 2), { mode: 0o600 });
}
async function persistFinalRecord(record: TaskRecord): Promise<void> {
  if (!record.artifactDir) return;
  await writeFile(join(record.artifactDir, "result.json"), JSON.stringify({
    status: record.status, error: record.error, tokens: record.tokens, taskResult: record.taskResult, worktree: record.worktree,
  }, null, 2), { mode: 0o600 });
}

async function cleanup(handoff: WorktreeHandoff): Promise<void> {
  const errors: string[] = [];
  try { await git(handoff.repoRoot, ["worktree", "remove", "--force", handoff.worktreePath]); }
  catch (error) { errors.push(`worktree remove: ${String(error)}`); }
  try { await git(handoff.repoRoot, ["branch", "-D", handoff.branch]); }
  catch (error) { errors.push(`branch delete: ${String(error)}`); }
  try { await rm(dirname(handoff.worktreePath), { recursive: false }); } catch { /* keep shared parent while non-empty */ }
  if (errors.length) {
    handoff.cleanupError = errors.join("\n");
    await persistHandoff(handoff);
  }
}

/** Create a strict sibling worktree. Never falls back to the shared checkout. */
export async function prepareTaskWorktree(plan: LaunchPlan, record: TaskRecord): Promise<void> {
  if (plan.task.isolation !== "worktree") return;
  const [{ stdout: rootOut }, { stdout: prefixOut }] = await Promise.all([
    git(plan.resources.cwd, ["rev-parse", "--show-toplevel"]),
    git(plan.resources.cwd, ["rev-parse", "--show-prefix"]),
  ]);
  const repoRoot = rootOut.trim();
  const { stdout: status } = await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim()) throw new Error("Worktree isolation requires a clean main Git checkout. Commit or stash existing changes first.");
  const { stdout: baseOut } = await git(repoRoot, ["rev-parse", "HEAD"]);
  const baseCommit = baseOut.trim();
  const suffix = `${plan.task.name}-${record.id.slice(0, 8)}`;
  const parent = join(dirname(repoRoot), ".xz-pi-worktrees");
  const worktreePath = join(parent, `${basename(repoRoot)}-${suffix}`);
  const branch = `xz-pi-subagents/${suffix}`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  const artifactDir = record.artifactDir;
  if (!artifactDir) throw new Error("Artifact directory must exist before worktree creation");
  record.worktree = {
    repoRoot, worktreePath, executionCwd: join(worktreePath, prefixOut.trim()), branch, baseCommit,
    patchPath: join(artifactDir, "changes.patch"), handoffPath: join(artifactDir, "handoff.json"),
    changedFiles: [], integration: "pending",
  };
  await persistHandoff(record.worktree);
}

/** Capture tracked, staged, deleted and untracked files as one binary-capable patch. */
export async function captureTaskWorktree(record: TaskRecord): Promise<void> {
  const handoff = record.worktree;
  if (!handoff) return;
  await git(handoff.worktreePath, ["add", "-N", "--all"]);
  const [{ stdout: patch }, { stdout: names }] = await Promise.all([
    git(handoff.worktreePath, ["diff", "--binary", "--no-ext-diff", handoff.baseCommit, "--"]),
    git(handoff.worktreePath, ["diff", "--name-only", "-z", handoff.baseCommit, "--"]),
  ]);
  handoff.changedFiles = names.split("\0").filter(Boolean);
  await writeFile(handoff.patchPath, patch, { mode: 0o600 });
  await persistHandoff(handoff);
}

/** Apply successful child patches serially to main. Applied/no-op worktrees are removed; failures with changes are preserved. */
export async function integrateTaskWorktrees(_plans: LaunchPlan[], records: TaskRecord[], changed: () => void): Promise<void> {
  for (const record of records) {
    const handoff = record.worktree;
    if (!handoff) continue;
    record.activity = "Preparing patch handoff"; changed();
    if (handoff.integration === "preserved") {
      record.activity = "Changes preserved for inspection";
      await persistFinalRecord(record); changed();
      continue;
    }
    if (!handoff.changedFiles.length) {
      handoff.integration = "no_changes";
      if (record.taskResult) record.taskResult.changedFiles = [];
      if (record.status === "completed" && record.requireChanges) {
        record.status = "failed";
        record.error = "Implementation completed without any captured file changes";
      }
      await persistHandoff(handoff);
      await cleanup(handoff);
      if (handoff.cleanupError) record.error = [record.error, `Automatic worktree cleanup incomplete: ${handoff.cleanupError}`].filter(Boolean).join("\n");
      record.activity = handoff.cleanupError ? "No changes; cleanup incomplete" : "";
      await persistFinalRecord(record); changed();
      continue;
    }
    if (record.status !== "completed") {
      handoff.integration = "preserved";
      await persistHandoff(handoff);
      record.activity = "Changes preserved for inspection";
      await persistFinalRecord(record); changed();
      continue;
    }
    record.activity = "Applying patch to main checkout"; changed();
    try {
      const { stdout: headOut } = await git(handoff.repoRoot, ["rev-parse", "HEAD"]);
      if (headOut.trim() !== handoff.baseCommit) throw new Error("Main HEAD changed while subagents were running");
      const patch = await readFile(handoff.patchPath);
      if (!patch.length) throw new Error("Captured patch is empty despite changed files");
      await git(handoff.repoRoot, ["apply", "--check", handoff.patchPath]);
      await git(handoff.repoRoot, ["apply", handoff.patchPath]);
      handoff.integration = "applied";
      if (record.taskResult) record.taskResult.changedFiles = [...handoff.changedFiles];
      await persistHandoff(handoff);
      await cleanup(handoff);
      if (handoff.cleanupError) record.error = `Patch applied, but automatic worktree cleanup was incomplete: ${handoff.cleanupError}`;
      record.activity = handoff.cleanupError ? "Patch applied; cleanup incomplete" : "Patch applied; worktree removed";
    } catch (error) {
      handoff.integration = "conflict";
      record.status = "failed";
      record.error = `Automatic patch integration failed; worktree preserved: ${String(error)}`;
      record.activity = "Integration failed; worktree preserved";
      await persistHandoff(handoff);
    }
    await persistFinalRecord(record);
    changed();
  }
}
