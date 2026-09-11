import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config, Registry } from "./types.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Store {
  readonly dir: string;
  readonly registryPath: string;
  readonly lockPath: string;
  readonly configPath: string;

  constructor(readonly root: string) {
    this.dir = join(root, ".pi", "side-agents-herdr");
    this.registryPath = join(this.dir, "registry.json");
    this.lockPath = join(this.dir, "registry.lock");
    this.configPath = join(this.dir, "config.json");
  }

  async config(): Promise<Config> {
    let value: Config;
    try { value = JSON.parse(await readFile(this.configPath, "utf8")) as Config; }
    catch { throw new Error(`Run /skill:agent-setup first; missing ${this.configPath}`); }
    if (value.version !== 1 || !value.mainBranch) throw new Error(`Invalid config: ${this.configPath}`);
    value.mainPaneRatio = typeof value.mainPaneRatio === "number" ? value.mainPaneRatio : 0.72;
    value.childSplitRatio = typeof value.childSplitRatio === "number" ? value.childSplitRatio : 0.5;
    value.cleanupOnQuit = value.cleanupOnQuit !== false;
    return value;
  }

  async load(): Promise<Registry> {
    try {
      const value = JSON.parse(await readFile(this.registryPath, "utf8")) as Registry;
      if (value.version !== 1 || !value.agents) throw new Error("unsupported registry");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, agents: {} };
      throw error;
    }
  }

  async save(registry: Registry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.registryPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.registryPath);
  }

  async mutate(fn: (registry: Registry) => void | Promise<void>): Promise<Registry> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - (await stat(this.lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
        if (age > 30_000) { await rm(this.lockPath, { force: true }); continue; }
        if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${this.lockPath}`);
        await sleep(50);
      }
    }
    try {
      const registry = await this.load();
      await fn(registry);
      await this.save(registry);
      return registry;
    } finally {
      await rm(this.lockPath, { force: true });
    }
  }
}
