import { isAbsolute } from "node:path";
import { Type } from "typebox";
import { getAgentDir, getPackageDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TaskManager } from "./src/manager.js";
import { planBatch } from "./src/policy.js";
import { cleanText } from "./src/protocol.js";
import { createRunner, piInvocation } from "./src/runner.js";
import { CHILD_ENV, DELEGATION_TOOLS, MAX_TASKS, TOOL_NAME, type BatchInput, type SkillRef, type TaskRecord } from "./src/types.js";
import { FleetView } from "./src/ui.js";

export default function xzSubagents(pi: ExtensionAPI): void {
  // Keep this package installed in children, but never install another orchestrator there.
  if (process.env[CHILD_ENV]) return;
  let manager = new TaskManager();
  let fleet = new FleetView(manager);
  let skills: SkillRef[] = [];
  pi.on("before_agent_start", event => {
    skills = (event.systemPromptOptions.skills ?? []).map(skill => ({ name: skill.name, filePath: skill.filePath }));
  });
  pi.on("session_start", (_event, ctx) => { fleet.attach(ctx); });
  pi.on("session_shutdown", async () => {
    fleet.dispose();
    await manager.dispose();
    manager = new TaskManager(); fleet = new FleetView(manager); skills = [];
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Multi agents",
    description: "Delegate 1–8 named tasks to independent Pi processes and WAIT for ALL results. No role registry: name labels this task. Main resumes only after every task completes, fails, times out or is cancelled. One batch at a time. Default read mode permits only main's active filesystem read/grep/find/ls tools. Write mode permits main's tools (including MCP/extensions); use it for implementation, shell, MCP or external tools. Both modes run concurrently by default. Set exclusive: true only for tasks that must not overlap any other child in this batch. tools narrows, never expands main's active tools. skills defaults to main's loaded catalog; [] disables skills. Children share the cwd, not conversation history; supply context explicitly. Returns bounded summaries (50 KB total), with output.md and events.jsonl paths for detail. No background daemon or recursive delegation.",
    promptSnippet: "Delegate independent tasks in parallel and wait for all results",
    promptGuidelines: [
      "Use xz_subagents_run when the user requests multi-agent work or delegation; keep small ordinary tasks in main.",
      "Put independent tasks in ONE xz_subagents_run call. Use separate rounds for dependencies. Give each child a self-contained task and report cancelled/failed tasks honestly.",
      "Tool access is not scheduling: independent web research can use mode: write with narrow tools and no exclusive flag. Set exclusive: true for conflicting workspace writes or control of a shared device/browser. Do not mutate those resources from main alongside the batch; exclusivity does not cover unrelated tools or external processes.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-zA-Z0-9_-]+$", description: "Unique task label, e.g. auth-scout or test-review" }),
        task: Type.String({ minLength: 1, maxLength: 32_000 }),
        mode: Type.Optional(Type.String({ enum: ["read", "write"], description: "Tool access only. Default read: filesystem readers. write: permits shell/MCP/extensions. Neither implies exclusive execution." })),
        exclusive: Type.Optional(Type.Boolean({ description: "Default false (parallel). True waits for all active children, then runs alone within this batch; use for conflicting writes/shared devices." })),
        model: Type.Optional(Type.String({ description: "Exact provider/modelId; defaults to main's current model" })),
        tools: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
        skills: Type.Optional(Type.Array(Type.String(), { maxItems: 128, description: "Names from main's loaded skills; omit to inherit, [] to disable" })),
      }), { minItems: 1, maxItems: MAX_TASKS }),
      context: Type.Optional(Type.String({ maxLength: 64_000, description: "Relevant background to share with all tasks, not the full main history" })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Concurrent tasks in either mode, default 4; explicit exclusive tasks run alone" })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Deadline per started task, default 600 seconds; queue time excluded" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const currentManager = manager;
      const active = pi.getActiveTools().filter(name => !DELEGATION_TOOLS.has(name));
      const tools = pi.getAllTools().filter(tool => active.includes(tool.name));
      const extensions = [...new Set(tools.map(tool => tool.sourceInfo.path).filter(path => isAbsolute(path)))];
      const plans = planBatch(params as BatchInput, {
        cwd: ctx.cwd, agentDir: getAgentDir(), trusted: ctx.isProjectTrusted(),
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
        thinking: pi.getThinkingLevel(), tools: active, skills, extensions,
      });
      const runner = createRunner({ invocation: piInvocation(getPackageDir()) });
      const records = await currentManager.run(plans, params.concurrency ?? 4, runner, signal);
      // Keep details bounded too: Pi persists tool details and may serialize them to RPC.
      const boundedOutput = (text: string): string => {
        const result = truncateHead(cleanText(text), { maxBytes: Math.floor(36_000 / records.length), maxLines: Math.floor(1400 / records.length) });
        return result.content + (result.truncated ? "\n[Output truncated; read output.md for the full result.]" : "");
      };
      const results = records.map(record => ({
        id: record.id, name: record.name, status: record.status, model: record.model, tokens: record.tokens,
        durationMs: record.startedAt ? (record.endedAt ?? Date.now()) - record.startedAt : 0,
        artifactDir: record.artifactDir,
        error: record.error ? truncateHead(cleanText(record.error), { maxBytes: 1024, maxLines: 20 }).content : undefined,
        output: boundedOutput(record.output),
      }));
      const summary = results.map(result => [
        `## ${result.name}: ${result.status}`, result.error ?? "", result.output,
        result.artifactDir ? `Full result: ${result.artifactDir}/output.md\nEvents: ${result.artifactDir}/events.jsonl` : "",
      ].filter(Boolean).join("\n")).join("\n\n");
      return {
        content: [{ type: "text", text: truncateHead(summary, { maxBytes: 50_000, maxLines: 2000 }).content }],
        details: { results },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Multi agents · ${args.tasks?.length ?? "…"} tasks`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "子任务运行中；在输入框下方按 ↓ 查看"), 0, 0);
      const results = (result.details as { results?: Array<Pick<TaskRecord, "name" | "status" | "error" | "output" | "artifactDir">> } | undefined)?.results;
      if (!results) return new Text(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), 0, 0);
      return new Text(results.map(r => `${r.name}: ${r.status}${expanded ? `\n${r.error ?? ""}\n${r.output}\n${r.artifactDir ?? ""}` : ""}`).join("\n"), 0, 0);
    },
  });
}
