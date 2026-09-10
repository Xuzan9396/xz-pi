import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { git } from "./git.js";
import { WorktreeStore } from "./store.js";
import type { CreateOptions, WorktreeManifest, WorktreeStoreOptions } from "./types.js";

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

export class WorktreeService {
  readonly store: WorktreeStore;
  private readonly worktreeParentName: string;

  constructor(options: WorktreeStoreOptions) {
    this.store = new WorktreeStore(options.stateRoot);
    this.worktreeParentName = options.worktreeParentName ?? ".xz-pi-worktrees";
  }

  async create(options: CreateOptions, signal?: AbortSignal): Promise<WorktreeManifest> {
    if (!NAME_PATTERN.test(options.name)) throw new Error("Worktree name must be 1–40 letters, digits, underscores, or hyphens");
    const [{ stdout: rootOut }, { stdout: prefixOut }] = await Promise.all([
      git(options.cwd, ["rev-parse", "--show-toplevel"], signal),
      git(options.cwd, ["rev-parse", "--show-prefix"], signal),
    ]);
    const repoRoot = rootOut.trim();
    const { stdout: status } = await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal);
    if (status.trim()) throw new Error("Creating a managed worktree requires a clean Git checkout. Commit or stash existing changes first.");
    const { stdout: baseOut } = await git(repoRoot, ["rev-parse", "HEAD"], signal);
    const id = randomUUID();
    const suffix = `${options.name}-${id.slice(0, 8)}`;
    const parent = join(dirname(repoRoot), this.worktreeParentName);
    const worktreePath = join(parent, `${basename(repoRoot)}-${suffix}`);
    const runDir = this.store.runDir(id);
    const now = new Date().toISOString();
    const manifest: WorktreeManifest = {
      version: 1,
      id,
      name: options.name,
      repoRoot,
      sourcePrefix: prefixOut.trim(),
      worktreePath,
      executionCwd: join(worktreePath, prefixOut.trim()),
      branch: `xz-pi-worktree/${suffix}`,
      baseCommit: baseOut.trim(),
      patchPath: join(runDir, "changes.patch"),
      changedFiles: [],
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      mkdir(parent, { recursive: true, mode: 0o700 }),
      mkdir(runDir, { recursive: true, mode: 0o700 }),
    ]);
    try {
      await git(repoRoot, ["worktree", "add", "-b", manifest.branch, worktreePath, manifest.baseCommit], signal);
      await this.store.save(manifest);
      return manifest;
    } catch (error) {
      if (existsSync(worktreePath)) await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
      await git(repoRoot, ["branch", "-D", manifest.branch]).catch(() => {});
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async status(id: string, signal?: AbortSignal): Promise<WorktreeManifest & { worktreeExists: boolean; dirty: boolean }> {
    const manifest = await this.store.load(id);
    const worktreeExists = existsSync(manifest.worktreePath);
    let dirty = false;
    if (worktreeExists) {
      const result = await git(manifest.worktreePath, ["status", "--porcelain", "--untracked-files=all"], signal);
      dirty = Boolean(result.stdout.trim());
    }
    return { ...manifest, worktreeExists, dirty };
  }

  async list(cwd?: string, signal?: AbortSignal): Promise<WorktreeManifest[]> {
    const manifests = await this.store.list();
    if (!cwd) return manifests;
    const { stdout } = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
    const root = stdout.trim();
    return manifests.filter(manifest => manifest.repoRoot === root);
  }

  async capture(id: string, signal?: AbortSignal): Promise<WorktreeManifest> {
    const manifest = await this.store.load(id);
    this.requireLive(manifest);
    await git(manifest.worktreePath, ["add", "-N", "--all"], signal);
    const [{ stdout: patch }, { stdout: names }] = await Promise.all([
      git(manifest.worktreePath, ["diff", "--binary", "--no-ext-diff", manifest.baseCommit, "--"], signal),
      git(manifest.worktreePath, ["diff", "--name-only", "-z", manifest.baseCommit, "--"], signal),
    ]);
    manifest.changedFiles = names.split("\0").filter(Boolean);
    manifest.status = manifest.changedFiles.length ? "captured" : "no_changes";
    manifest.error = undefined;
    await writeFile(manifest.patchPath, patch, { mode: 0o600 });
    await this.store.save(manifest);
    return manifest;
  }

  async apply(id: string, signal?: AbortSignal): Promise<WorktreeManifest> {
    const manifest = await this.capture(id, signal);
    if (!manifest.changedFiles.length) {
      manifest.status = "no_changes";
      await this.cleanup(manifest, signal);
      await this.store.save(manifest);
      return manifest;
    }
    try {
      const [{ stdout: headOut }, { stdout: mainStatus }] = await Promise.all([
        git(manifest.repoRoot, ["rev-parse", "HEAD"], signal),
        git(manifest.repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal),
      ]);
      if (headOut.trim() !== manifest.baseCommit) throw new Error("Main HEAD changed after the managed worktree was created");
      if (mainStatus.trim()) throw new Error("Applying a managed worktree requires a clean main checkout");
      const patch = await readFile(manifest.patchPath);
      if (!patch.length) throw new Error("Captured patch is empty despite changed files");
      await git(manifest.repoRoot, ["apply", "--check", manifest.patchPath], signal);
      await git(manifest.repoRoot, ["apply", manifest.patchPath], signal);
    } catch (error) {
      manifest.status = "conflict";
      manifest.error = String(error);
      await this.store.save(manifest);
      throw new Error(`Worktree patch was not applied; worktree and patch preserved. ${String(error)}`);
    }
    manifest.status = "applied";
    manifest.error = undefined;
    try {
      await this.store.save(manifest);
      await this.cleanup(manifest, signal);
      await this.store.save(manifest);
      return manifest;
    } catch (error) {
      manifest.error = `Patch applied, but finalization failed: ${String(error)}`;
      await this.store.save(manifest).catch(() => {});
      throw new Error(manifest.error);
    }
  }

  async remove(id: string, force = false, signal?: AbortSignal): Promise<WorktreeManifest> {
    const manifest = await this.store.load(id);
    if (existsSync(manifest.worktreePath) && !force) {
      const { stdout } = await git(manifest.worktreePath, ["status", "--porcelain", "--untracked-files=all"], signal);
      if (stdout.trim()) throw new Error("Worktree has changes. Capture/apply them first or set force: true.");
    }
    await this.cleanup(manifest, signal, force);
    if (manifest.cleanupError) throw new Error(`Worktree cleanup incomplete: ${manifest.cleanupError}`);
    manifest.status = "removed";
    manifest.error = undefined;
    await this.store.save(manifest);
    return manifest;
  }

  private requireLive(manifest: WorktreeManifest): void {
    if (!existsSync(manifest.worktreePath)) throw new Error(`Managed worktree no longer exists: ${manifest.worktreePath}`);
    if (manifest.status === "applied" || manifest.status === "removed") throw new Error(`Worktree is already ${manifest.status}`);
  }

  private async cleanup(manifest: WorktreeManifest, signal?: AbortSignal, force = true): Promise<void> {
    const errors: string[] = [];
    if (existsSync(manifest.worktreePath)) {
      const args = ["worktree", "remove", ...(force ? ["--force"] : []), manifest.worktreePath];
      try { await git(manifest.repoRoot, args, signal); }
      catch (error) { errors.push(`worktree remove: ${String(error)}`); }
    }
    try { await git(manifest.repoRoot, ["branch", "-D", manifest.branch], signal); }
    catch (error) {
      const branches = await git(manifest.repoRoot, ["branch", "--list", manifest.branch], signal).catch(() => ({ stdout: manifest.branch, stderr: "" }));
      if (branches.stdout.trim()) errors.push(`branch delete: ${String(error)}`);
    }
    try { await rm(dirname(manifest.worktreePath), { recursive: false }); } catch { /* Shared parent remains while non-empty. */ }
    manifest.cleanupError = errors.length ? errors.join("\n") : undefined;
  }
}
