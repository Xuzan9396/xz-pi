export const TOOL_NAME = "xz_subagents_run";
export const CHILD_ENV = "XZ_PI_SUBAGENT_CONFIG";
export const MAX_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
// Control-plane guard, not a sandbox: a shell or third-party tool can still spawn processes.
export const DELEGATION_TOOLS = new Set([
  TOOL_NAME, "subagent", "get_subagent_result", "steer_subagent",
  "agent_start", "agent_resume", "agent_wait", "agent_wait_all", "agent_cancel", "agent_steer", "agent_result",
]);

export type TaskOperation = "general" | "inspect" | "research" | "implement" | "test" | "review" | "integrate";

export interface TaskInput {
  name: string;
  task: string;
  mode?: "read" | "write";
  operation?: TaskOperation;
  context?: string;
  exclusive?: boolean;
  model?: string;
  tools?: string[];
  skills?: string[];
}
export interface BatchInput {
  tasks: TaskInput[];
  context?: string;
  concurrency?: number;
}
export interface SkillRef { name: string; filePath: string }
export interface Resources {
  cwd: string;
  agentDir: string;
  model: string;
  thinking: string;
  trusted: boolean;
  tools: string[];
  skills: SkillRef[];
  extensions: string[];
}
export interface LaunchPlan {
  task: TaskInput;
  resources: Resources;
  context: string;
  tools: string[];
  skillPaths: string[];
}
export type TaskStatus = "queued" | "running" | "paused" | "resuming" | "stopping" | "completed" | "failed" | "cancelled";
export const isTerminal = (status: TaskStatus): boolean => ["completed", "failed", "cancelled"].includes(status);
export interface StructuredTaskResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  changedFiles: string[];
  commandsRun: Array<{ command: string; exitCode: number; summary: string }>;
  tests: Array<{ name: string; passed: boolean; evidence: string }>;
  findings: Array<{ severity: "high" | "medium" | "low"; description: string; file?: string; line?: number }>;
  assumptions: string[];
  blockers: string[];
}
export interface TaskRecord {
  id: string;
  name: string;
  task: string;
  mode: "read" | "write";
  operation: TaskOperation;
  exclusive: boolean;
  model: string;
  status: TaskStatus;
  attempt: number;
  startedAt?: number;
  endedAt?: number;
  activity: string;
  transcript: string;
  output: string;
  error?: string;
  lastError?: string;
  artifactDir?: string;
  attemptDir?: string;
  taskResult?: StructuredTaskResult;
  tokens: number;
}
export interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  output: string;
  error?: string;
  taskResult?: StructuredTaskResult;
}
export type TaskRunner = (plan: LaunchPlan, record: TaskRecord, signal: AbortSignal, changed: () => void) => Promise<RunOutcome>;
export interface ChildConfig {
  tools: string[];
  parentPid: number;
}
