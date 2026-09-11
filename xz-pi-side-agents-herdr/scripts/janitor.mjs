#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const payload = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const dir = join(payload.root, ".pi", "side-agents-herdr");
const registryPath = join(dir, "registry.json");
const lockPath = join(dir, "registry.lock");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

async function mutate(fn) {
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  while (true) {
    try { const handle = await open(lockPath, "wx", 0o600); await handle.close(); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 30_000) { await rm(lockPath, { force: true }); continue; }
      if (Date.now() - started > 10_000) throw new Error(`registry lock timeout: ${lockPath}`);
      await sleep(50);
    }
  }
  try {
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    await fn(registry);
    const temporary = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, registryPath);
  } finally { await rm(lockPath, { force: true }); }
}

try {
  // Wait for Pi to finish session persistence and release its Herdr agent name.
  // A bounded fallback still prevents a stuck detector from leaking cleanup forever.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const live = await exec("herdr", ["agent", "get", payload.id]).then(() => true, () => false);
    if (!live) break;
    await sleep(100);
  }
  if (payload.paneId) {
    const confirmation = join(dir, `cleanup-confirm-${payload.id}`);
    await rm(confirmation, { force: true });
    const prompt = "[side-agent] Work is clean and merged. Press any key to remove the worktree and close this pane...";
    const inner = `printf '%s' ${shellQuote(prompt)}; IFS= read -r -n 1 _; printf '\\n'; : > ${shellQuote(confirmation)}`;
    await exec("herdr", ["pane", "run", payload.paneId, `bash -lc ${shellQuote(inner)}`]);
    while (true) {
      const confirmed = await stat(confirmation).then(() => true, () => false);
      if (confirmed) break;
      const paneExists = await exec("herdr", ["pane", "get", payload.paneId]).then(() => true, () => false);
      if (!paneExists) {
        await mutate(registry => {
          const record = registry.agents[payload.id];
          if (!record) return;
          record.status = "paused";
          record.warnings = [...(record.warnings ?? []), "Cleanup confirmation pane was closed; worktree was preserved."];
          record.updatedAt = new Date().toISOString();
        });
        process.exit(0);
      }
      await sleep(200);
    }
    await rm(confirmation, { force: true });
  }
  await exec("git", ["-C", payload.root, "worktree", "remove", payload.worktreePath], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  await exec("git", ["-C", payload.root, "worktree", "prune"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  // The child already checked this before requesting cleanup; verify again to
  // avoid deleting a branch if the integration ref changed during shutdown.
  const ancestry = await exec("git", ["-C", payload.root, "merge-base", "--is-ancestor", payload.branch, payload.mainBranch]).then(() => true, () => false);
  if (ancestry) await exec("git", ["-C", payload.root, "branch", "-D", payload.branch], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (payload.paneId) await exec("herdr", ["pane", "close", payload.paneId]).catch(() => undefined);
  await mutate(registry => { delete registry.agents[payload.id]; });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await mutate(registry => {
    const record = registry.agents[payload.id];
    if (!record) return;
    const paneGone = message.includes("pane_not_found");
    record.status = paneGone ? "paused" : "failed";
    if (paneGone) {
      record.warnings = [...(record.warnings ?? []), "Cleanup confirmation pane disappeared; worktree was preserved."];
      delete record.error;
    } else {
      record.error = `Cleanup failed: ${message}`;
    }
    record.updatedAt = new Date().toISOString();
  }).catch(() => undefined);
}
