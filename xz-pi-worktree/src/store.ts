import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeManifest } from "./types.js";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorktreeStore {
  constructor(readonly root: string) {}

  runDir(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error("Invalid worktree id");
    return join(this.root, id);
  }

  manifestPath(id: string): string {
    return join(this.runDir(id), "manifest.json");
  }

  async save(manifest: WorktreeManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    const dir = this.runDir(manifest.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(this.manifestPath(manifest.id), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }

  async load(id: string): Promise<WorktreeManifest> {
    const value = JSON.parse(await readFile(this.manifestPath(id), "utf8")) as WorktreeManifest;
    if (value.version !== 1 || value.id !== id) throw new Error(`Invalid manifest for worktree ${id}`);
    return value;
  }

  async list(): Promise<WorktreeManifest[]> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests: WorktreeManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try { manifests.push(await this.load(entry.name)); } catch { /* Ignore corrupt entries in list; direct status reports them. */ }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
