import { isAbsolute } from "node:path";
import { DELEGATION_TOOLS, MAX_CONCURRENCY, MAX_TASKS, READ_TOOLS, type BatchInput, type LaunchPlan, type Resources, type TaskOperation } from "./types.js";

const OPERATIONS = new Set<TaskOperation>(["general", "inspect", "research", "implement", "test", "review", "integrate"]);

export function planBatch(input: BatchInput, resources: Resources): LaunchPlan[] {
  if (!input.tasks.length || input.tasks.length > MAX_TASKS) throw new Error(`Supply 1–${MAX_TASKS} tasks in one batch.`);
  if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 64_000)) throw new Error("Invalid shared context");
  const concurrency = input.concurrency ?? MAX_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error("concurrency must be 1–4");
  const seconds = input.timeoutSeconds ?? 600;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error("timeoutSeconds must be 1–1800");
  if (!resources.model) throw new Error("No parent model selected.");
  const available = new Set(resources.tools.filter(name => !DELEGATION_TOOLS.has(name)));
  const names = new Set<string>();
  return input.tasks.map(task => {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(task.name) || names.has(task.name)) throw new Error("Task names must be unique, 1–40 letters/digits/_/-.");
    names.add(task.name);
    if (!task.task.trim() || task.task.length > 32_000) throw new Error(`Invalid task text: ${task.name}`);
    if (task.mode && task.mode !== "read" && task.mode !== "write") throw new Error(`Invalid mode: ${task.mode}`);
    if (task.operation !== undefined && !OPERATIONS.has(task.operation)) throw new Error(`Invalid operation: ${task.operation}`);
    if (task.context !== undefined && (typeof task.context !== "string" || task.context.length > 64_000)) throw new Error(`Invalid task context: ${task.name}`);
    if (task.isolation !== undefined && task.isolation !== "worktree") throw new Error(`Invalid isolation: ${task.isolation}`);
    if (task.requireChanges !== undefined && typeof task.requireChanges !== "boolean") throw new Error("requireChanges must be a boolean");
    if (task.exclusive !== undefined && typeof task.exclusive !== "boolean") throw new Error("exclusive must be a boolean");
    const mode = task.mode ?? "read";
    const operation = task.operation ?? "general";
    if (operation === "implement" && mode !== "write") throw new Error("implement tasks require mode: write");
    if (task.isolation === "worktree" && (mode !== "write" || operation !== "implement")) throw new Error("worktree isolation is only available for mode: write, operation: implement tasks");
    if (task.requireChanges !== undefined && task.isolation !== "worktree") throw new Error("requireChanges requires worktree isolation");
    const tools = [...new Set(task.tools ?? [...available].filter(name => mode === "write" || READ_TOOLS.has(name)))];
    for (const name of tools) {
      if (!available.has(name)) throw new Error(`Tool ${name} is not active in main or is a delegation tool.`);
      if (mode === "read" && !READ_TOOLS.has(name)) throw new Error(`${name} needs mode: write for tool access, including MCP/extension tools. Scheduling is controlled separately by exclusive.`);
    }
    if (task.model && (!task.model.includes("/") || task.model.startsWith("-") || /\s/.test(task.model))) throw new Error("model must be an exact provider/modelId reference");
    const skills = task.skills === undefined ? resources.skills : task.skills.map(name => {
      const skill = resources.skills.find(s => s.name === name);
      if (!skill) throw new Error(`Skill ${name} is not loaded in main.`);
      return skill;
    });
    if (skills.length && !tools.includes("read")) throw new Error("Skills require the read tool. Set skills: [] for a tools-only child.");
    if (skills.some(skill => !isAbsolute(skill.filePath))) throw new Error("Skills must have absolute file paths.");
    const commonContext = input.context?.trim();
    const taskContext = task.context?.trim();
    const context = [commonContext ? `Shared batch context:\n${commonContext}` : "", taskContext ? `Task-specific context:\n${taskContext}` : ""].filter(Boolean).join("\n\n");
    if (context.length > 96_000) throw new Error(`Combined context is too large: ${task.name}`);
    return {
      task: { ...task, mode, operation, requireChanges: task.requireChanges ?? task.isolation === "worktree", exclusive: task.exclusive ?? false }, resources, context, tools,
      skillPaths: [...new Set(skills.map(s => s.filePath))], timeoutMs: seconds * 1000,
    };
  });
}

export function delegationAllowed(name: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(name) && !DELEGATION_TOOLS.has(name);
}
