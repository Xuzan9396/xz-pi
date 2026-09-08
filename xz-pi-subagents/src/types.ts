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

export interface TaskInput {
  name: string;
  task: string;
  mode?: "read" | "write";
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
export interface TaskRecord {
  id: string;
  name: string;
  task: string;
  mode: "read" | "write";
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
  tokens: number;
}
export interface RunOutcome {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  output: string;
  error?: string;
}
export type TaskRunner = (plan: LaunchPlan, record: TaskRecord, signal: AbortSignal, changed: () => void) => Promise<RunOutcome>;
export interface ChildConfig {
  tools: string[];
  parentPid: number;
}
