export const TOOL_NAME = "xz_subagents_run";
export const CHILD_ENV = "XZ_PI_SUBAGENT_CONFIG";
export const MIN_TASKS = 2;
export const MAX_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
// Control-plane guard, not a sandbox: a shell or third-party tool can still spawn processes.
export const DELEGATION_TOOLS = new Set([
  TOOL_NAME, "subagent", "get_subagent_result", "steer_subagent",
  "agent_start", "agent_resume", "agent_wait", "agent_wait_all", "agent_cancel", "agent_steer", "agent_result",
]);

export type TaskOperation = "general" | "inspect" | "research" | "implement" | "test" | "review" | "integrate";
export type TaskIsolation = "worktree";

export interface TaskInput {
  name: string;
  task: string;
  mode?: "read" | "write";
  operation?: TaskOperation;
  context?: string;
  isolation?: TaskIsolation;
  requireChanges?: boolean;
  exclusive?: boolean;
  model?: string;
  tools?: string[];
  skills?: string[];
}
export interface BatchInput {
  tasks: TaskInput[];
  context?: string;
  concurrency?: number;
  timeoutSeconds?: number;
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
  timeoutMs: number;
}
export type TaskStatus = "queued" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "timed_out";
export const isTerminal = (status: TaskStatus): boolean => !["queued", "running", "stopping"].includes(status);
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
export interface WorktreeHandoff {
  repoRoot: string;
  worktreePath: string;
  executionCwd: string;
  branch: string;
  baseCommit: string;
  patchPath: string;
  handoffPath: string;
  changedFiles: string[];
  integration: "pending" | "applied" | "no_changes" | "conflict" | "preserved";
  cleanupError?: string;
}
export interface TaskRecord {
  id: string;
  name: string;
  task: string;
  mode: "read" | "write";
  operation: TaskOperation;
  isolation?: TaskIsolation;
  requireChanges: boolean;
  exclusive: boolean;
  model: string;
  status: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  activity: string;
  transcript: string;
  output: string;
  error?: string;
  artifactDir?: string;
  taskResult?: StructuredTaskResult;
  worktree?: WorktreeHandoff;
  tokens: number;
}
export interface RunOutcome {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  output: string;
  error?: string;
  taskResult?: StructuredTaskResult;
}
export type TaskRunner = (plan: LaunchPlan, record: TaskRecord, signal: AbortSignal, changed: () => void) => Promise<RunOutcome>;
export type BatchFinalizer = (plans: LaunchPlan[], records: TaskRecord[], changed: () => void) => Promise<void>;
export interface ChildConfig {
  tools: string[];
  parentPid: number;
}
