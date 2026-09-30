import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { usageDataDir } from "./cache.js";

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

export function usageLockPath(): string {
  return join(usageDataDir(), "refresh.lock");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isStale(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as { createdAt?: unknown };
    const createdAt = Number(owner.createdAt);
    return !Number.isFinite(createdAt) || Date.now() - createdAt > LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

export async function withUsageLock<T>(run: () => Promise<T>, path = usageLockPath()): Promise<T> {
  await mkdir(usageDataDir(), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStale(path)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > LOCK_WAIT_MS) throw new Error("usage refresh lock timeout");
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await run();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
