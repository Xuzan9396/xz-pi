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
  pi.registerCommand("agent_show", {
    description: "重新展示当前或最近一批子 Agent 任务面板",
    handler: async (_args, ctx) => {
      fleet.attach(ctx);
      if (!fleet.show()) ctx.ui.notify("当前 Session 没有子 Agent 任务", "info");
    },
  });
  pi.on("session_shutdown", async () => {
    fleet.dispose();
    await manager.dispose();
    manager = new TaskManager(); fleet = new FleetView(manager); skills = [];
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Multi agents",
    description: "Delegate 1–8 named tasks to independent Pi processes and WAIT for ALL results, with no automatic task deadline. A failed child settles immediately and never waits for interactive retry; siblings continue. Main resumes after every task completes, fails, or is cancelled. Use operation to define the task contract. Default read mode grants the parent's active read and bash/search tools but instructs the child not to modify state; it is a behavioral contract, not a sandbox. Write mode permits all active parent tools. Both modes run concurrently by default; exclusive is scheduling only. tools narrows, never expands main's active tools. Children share the current project directory, not conversation history; supply concise shared/task context explicitly. This tool does not create isolated workspaces or integrate file changes. No background daemon or recursive delegation.",
    promptSnippet: "Delegate independent tasks in parallel and wait for all results",
    promptGuidelines: [
      "Use xz_subagents_run when the user requests multi-agent work or delegation; keep small ordinary tasks in main.",
      "Put independent tasks in ONE xz_subagents_run call. Use separate rounds for dependencies. Give each child a self-contained task and report cancelled/failed tasks honestly.",
      "Tool access is not scheduling: independent web research can use mode: write with operation: research and narrow tools. Set exclusive: true for shared devices, browsers, or workspace mutations that must not overlap.",
      "Read mode normally includes active read and bash/search tools. For repository-wide inspection, omit tools or keep bash; use tools: [\"read\"] only when every required file path is already known.",
      "All xz_subagents_run children share the current project directory. Assign disjoint files to concurrent implementation tasks or make conflicting mutations exclusive; this tool does not provide workspace isolation or patch integration.",
      "For precise delivery, give each task explicit paths, constraints and acceptance evidence. Use separate wait barriers: parallel inspect/research, then implementation, then fresh review/tests.",
      "xz_subagents_run has no automatic timeout. Failed children settle immediately without interactive retry; inspect the error and delegate a smaller corrected task only when needed.",
      "Skills inherit only when the resolved child tools include read. If a narrow tool list omits read, implicit skills are disabled automatically; explicit non-empty skills still require read.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-zA-Z0-9_-]+$", description: "Unique task label, e.g. auth-scout or test-review" }),
        task: Type.String({ minLength: 1, maxLength: 32_000 }),
        mode: Type.Optional(Type.String({ enum: ["read", "write"], description: "Behavior/tool access. Default read: active read plus bash/search tools, with a no-modification instruction (not a sandbox). write: all active parent tools. Neither implies exclusive execution." })),
        operation: Type.Optional(Type.String({ enum: ["general", "inspect", "research", "implement", "test", "review", "integrate"], description: "Behavior/result contract. Use implement only for code changes; default general preserves compatibility." })),
        context: Type.Optional(Type.String({ maxLength: 64_000, description: "Background specific to this task, appended after shared batch context" })),
        exclusive: Type.Optional(Type.Boolean({ description: "Default false (parallel). True waits for all active children, then runs alone within this batch; use for conflicting workspace writes/shared devices." })),
        model: Type.Optional(Type.String({ description: "Exact provider/modelId; defaults to main's current model" })),
        tools: Type.Optional(Type.Array(Type.String(), { maxItems: 128, description: "Narrows the mode's default tools. For repository-wide read tasks, omit this or retain bash/search capability." })),
        skills: Type.Optional(Type.Array(Type.String(), { maxItems: 128, description: "Names from main's loaded skills; omit to inherit when read is available (otherwise auto-disabled), [] to disable" })),
      }), { minItems: 1, maxItems: MAX_TASKS }),
      context: Type.Optional(Type.String({ maxLength: 64_000, description: "Relevant background to share with all tasks, not the full main history" })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Concurrent tasks in either mode, default 4; explicit exclusive tasks run alone" })),
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
        artifactDir: record.artifactDir, taskResult: record.taskResult,
        error: record.error ? truncateHead(cleanText(record.error), { maxBytes: 1024, maxLines: 20 }).content : undefined,
        output: boundedOutput(record.output),
      }));
      const summary = results.map(result => [
        `## ${result.name}: ${result.status}`, result.error ?? "", result.output,
        result.taskResult ? `Structured result: ${JSON.stringify(result.taskResult)}` : "",
        result.artifactDir ? `Output: ${result.artifactDir}/output.md\nEvents: ${result.artifactDir}/events.jsonl` : "",
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
