import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { handleChildQuit, linkChildSession } from "./src/lifecycle.js";
import { repoRoot, SideAgentService } from "./src/service.js";
import { ENV, type AgentRecord } from "./src/types.js";

const terminal = new Set(["waiting_user", "blocked", "paused", "failed", "crashed"]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function parseAgentArgs(raw: string): { task: string; model?: string; mode?: string } {
  let rest = raw;
  const modelMatch = rest.match(/(?:^|\s)-model\s+(\S+)/);
  const modeMatch = rest.match(/(?:^|\s)-mode\s+(\S+)/);
  if (modelMatch) rest = rest.replace(modelMatch[0], " ");
  if (modeMatch) rest = rest.replace(modeMatch[0], " ");
  return { task: rest.trim(), model: modelMatch?.[1], mode: modeMatch?.[1] };
}

async function modelFor(ctx: ExtensionContext, requested?: string, mode?: string): Promise<string | undefined> {
  if (requested) return requested.includes("/") ? requested : requested;
  if (mode) {
    for (const path of [join(ctx.cwd, ".pi", "modes.json"), join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "modes.json")]) {
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as { modes?: Record<string, { provider?: string; modelId?: string; thinkingLevel?: string }> };
        const spec = value.modes?.[mode];
        if (spec?.provider && spec.modelId) return `${spec.provider}/${spec.modelId}${spec.thinkingLevel ? `:${spec.thinkingLevel}` : ""}`;
      } catch { /* try next */ }
    }
    throw new Error(`Mode '${mode}' was not found in .pi/modes.json or the global modes.json`);
  }
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function serviceFor(ctx: ExtensionContext): Promise<SideAgentService> {
  const root = process.env[ENV.stateRoot] || await repoRoot(ctx.cwd);
  return new SideAgentService(root);
}

function summary(record: AgentRecord): string {
  return `${record.id}  ${record.status}  pane:${record.paneId ?? "-"}  worktree:${record.worktreePath}\n  task: ${record.task.slice(0, 180)}`;
}

export default function sideAgentsHerdr(pi: ExtensionAPI): void {
  if (process.env[ENV.agentId]) {
    pi.on("session_start", async (_event, ctx) => { await linkChildSession(await serviceFor(ctx), ctx).catch(() => undefined); });
    pi.on("agent_start", async (_event, ctx) => { const service = await serviceFor(ctx); await service.update(process.env[ENV.agentId]!, { status: "running" }).catch(() => undefined); });
    pi.on("agent_end", async (_event, ctx) => { const service = await serviceFor(ctx); await service.update(process.env[ENV.agentId]!, { status: "waiting_user" }).catch(() => undefined); });
    pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason === "quit") await handleChildQuit(await serviceFor(ctx), ctx).catch(error => console.error(`[side-agent] quit cleanup check failed: ${String(error)}`));
    });
    return;
  }

  let statusTimer: NodeJS.Timeout | undefined;
  const updateStatus = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      const records = await (await serviceFor(ctx)).list();
      const text = records.map(record => `${record.id}:${record.status}@${record.paneId ?? "-"}`).join(" ");
      ctx.ui.setStatus("side-agents-herdr", text || undefined);
    } catch { /* status is best effort */ }
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && !statusTimer) {
      statusTimer = setInterval(() => void updateStatus(ctx), 2500);
      statusTimer.unref();
    }
    void updateStatus(ctx);
  });
  pi.on("session_shutdown", () => { if (statusTimer) clearInterval(statusTimer); statusTimer = undefined; });

  pi.registerCommand("agent", {
    description: "Spawn a background child Pi agent in a Herdr pane/worktree: /agent [-model <provider/id>] [-mode <name>] <task>",
    handler: async (args, ctx) => {
      const parsed = parseAgentArgs(args);
      if (!parsed.task) { ctx.ui.notify("Usage: /agent [-model <provider/id>] [-mode <name>] <task>", "error"); return; }
      if (!ctx.isProjectTrusted()) { ctx.ui.notify("Side-agent creation requires a trusted project", "error"); return; }
      try {
        const result = await (await serviceFor(ctx)).start(ctx, { task: parsed.task, model: await modelFor(ctx, parsed.model, parsed.mode) });
        ctx.ui.notify(`Started ${result.id}\npane: ${result.paneId}\nworktree: ${result.worktreePath}\nbranch: ${result.branch}`, "info");
        await updateStatus(ctx);
      } catch (error) { ctx.ui.notify(`Failed to start agent: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });

  pi.registerCommand("agents", {
    description: "List tracked side agents",
    handler: async (_args, ctx) => {
      try {
        const records = await (await serviceFor(ctx)).list();
        ctx.ui.notify(records.length ? records.map(summary).join("\n\n") : "No tracked side agents.", "info");
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });

  pi.registerCommand("agent-resume", {
    description: "Resume a previously /quit side-agent session in its retained worktree/Herdr pane",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("/agent-resume takes no arguments", "error"); return; }
      if (!ctx.hasUI) return;
      const service = await serviceFor(ctx);
      const candidates = (await service.list()).filter(record => ["paused", "failed", "crashed"].includes(record.status) && record.childSessionId);
      if (!candidates.length) { ctx.ui.notify("No resumable side-agent sessions.", "info"); return; }
      const labels = candidates.map(summary);
      const selected = await ctx.ui.select("Resume side-agent", labels);
      if (!selected) return;
      const candidate = candidates[labels.indexOf(selected)];
      try {
        const result = await service.start(ctx, { task: candidate.task, resumeId: candidate.id });
        ctx.ui.notify(`Resumed ${result.id} in pane ${result.paneId}`, "info");
      } catch (error) { ctx.ui.notify(`Failed to resume: ${String(error)}`, "error"); }
    },
  });

  pi.registerTool({
    name: "agent-start", label: "Agent Start",
    description: "Start a background side agent in a Herdr pane and isolated Git worktree. Commands match pi-side-agents. Returns { ok, id, task, paneId, tabId, workspaceId, worktreePath, branch, warnings }.",
    parameters: Type.Object({
      description: Type.String({ description: "Self-contained task description" }),
      branchHint: Type.String({ description: "Short kebab-case feature slug, max 3 words" }),
      model: Type.Optional(Type.String({ description: "Optional provider/modelId" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        signal?.throwIfAborted();
        if (!ctx.isProjectTrusted()) throw new Error("agent-start requires a trusted project");
        const result = await (await serviceFor(ctx)).start(ctx, { task: params.description, branchHint: params.branchHint, model: await modelFor(ctx, params.model) });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) {
        const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `Agent Start · ${args.branchHint}`), 0, 0); },
  });

  pi.registerTool({
    name: "agent-check", label: "Agent Check",
    description: "Check a side agent and return its Herdr status, pane/worktree metadata, and recent terminal output.",
    parameters: Type.Object({ id: Type.String({ description: "Agent id" }) }),
    async execute(_id, params, _signal, _update, ctx) {
      try { const value = await (await serviceFor(ctx)).check(params.id); return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }; }
      catch (error) { const value = { ok: false, error: String(error) }; return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }; }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `Agent Check · ${args.id}`), 0, 0); },
  });

  pi.registerTool({
    name: "agent-wait-any", label: "Agent Wait Any",
    description: "Wait until any requested side agent finishes, yields, blocks, pauses, fails, or crashes.",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const service = await serviceFor(ctx);
      const known = new Set<string>();
      while (!signal?.aborted) {
        for (const id of [...new Set(params.ids)]) {
          const value = await service.check(id);
          if (value.ok === true) {
            known.add(id);
            const status = (value.agent as AgentRecord).status;
            if (terminal.has(status)) return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
          } else if (known.has(id)) {
            const done = { ok: true, agent: { id, status: "done" }, backlog: [] };
            return { content: [{ type: "text", text: JSON.stringify(done, null, 2) }], details: done };
          } else {
            return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
          }
        }
        await sleep(1000);
      }
      const aborted = { ok: false, error: "agent-wait-any aborted" };
      return { content: [{ type: "text", text: JSON.stringify(aborted, null, 2) }], details: aborted };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `Agent Wait · ${args.ids?.join(", ") ?? ""}`), 0, 0); },
  });

  pi.registerTool({
    name: "agent-send", label: "Agent Send",
    description: "Send a prompt to a side agent through Herdr. Prefix ! interrupts first; slash commands such as /quit are forwarded unchanged.",
    parameters: Type.Object({ id: Type.String(), prompt: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      try { const value = await (await serviceFor(ctx)).send(params.id, params.prompt); return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }; }
      catch (error) { const value = { ok: false, message: String(error) }; return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }; }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `Agent Send · ${args.id}`), 0, 0); },
  });
}
