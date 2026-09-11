import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { git } from "./process.js";
import { SideAgentService } from "./service.js";
import { ENV } from "./types.js";

export async function linkChildSession(service: SideAgentService, ctx: ExtensionContext): Promise<void> {
  const id = process.env[ENV.agentId];
  if (!id) return;
  await service.update(id, {
    childSessionId: ctx.sessionManager.getSessionFile(),
    status: "running",
  });
}

export function cleanupBlockers(dirty: string, unmerged: number, mainBranch: string): string[] {
  return [
    dirty.trim() ? "存在未提交修改" : "",
    unmerged > 0 ? `有 ${unmerged} 个提交尚未合并到 ${mainBranch}` : "",
  ].filter(Boolean);
}

export async function handleChildQuit(service: SideAgentService, ctx: ExtensionContext): Promise<void> {
  const id = process.env[ENV.agentId];
  if (!id) return;
  const record = await service.requireRecord(id);
  const config = await service.store.config();
  if (!config.cleanupOnQuit) {
    await service.update(id, { status: "paused" });
    return;
  }
  const dirty = (await git(record.worktreePath, ["status", "--porcelain"])).stdout.trim();
  const unmerged = Number((await git(record.worktreePath, ["rev-list", "--count", `${record.mainBranch}..${record.branch}`])).stdout.trim() || "0");

  const reasons = cleanupBlockers(dirty, unmerged, record.mainBranch);
  if (reasons.length) {
    const message = `未清理 ${record.worktreePath}，因为${reasons.join("，")}。Pane 保留，可使用 /agent-resume 恢复。`;
    await service.update(id, { status: "paused", warnings: [...record.warnings, message] });
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    console.error(`[side-agent] ${message}`);
    return;
  }

  await service.update(id, { status: "cleaning" });
  const script = fileURLToPath(new URL("../scripts/janitor.mjs", import.meta.url));
  const payload = Buffer.from(JSON.stringify({
    root: service.root,
    id,
    paneId: record.paneId,
    worktreePath: record.worktreePath,
    branch: record.branch,
    mainBranch: record.mainBranch,
  })).toString("base64url");
  const child = spawn(process.execPath, [script, payload], {
    cwd: service.root,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
