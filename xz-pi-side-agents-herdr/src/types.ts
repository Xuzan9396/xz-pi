export const ENV = {
  agentId: "PI_SIDE_AGENT_ID",
  parentSession: "PI_SIDE_PARENT_SESSION",
  parentRepo: "PI_SIDE_PARENT_REPO",
  stateRoot: "PI_SIDE_AGENTS_ROOT",
} as const;

export type AgentStatus =
  | "allocating_worktree"
  | "spawning_pane"
  | "starting"
  | "running"
  | "waiting_user"
  | "blocked"
  | "paused"
  | "cleaning"
  | "failed"
  | "crashed";

export interface Config {
  version: 1;
  mainBranch: string;
  mainPaneRatio: number;
  childSplitRatio: number;
  cleanupOnQuit: boolean;
}

export interface AgentRecord {
  id: string;
  feature: string;
  number: number;
  task: string;
  status: AgentStatus;
  mainBranch: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  herdrAgentName?: string;
  parentSessionId?: string;
  childSessionId?: string;
  model?: string;
  kickoffPending?: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  warnings: string[];
}

export interface Registry {
  version: 1;
  agents: Record<string, AgentRecord>;
}

export interface StartResult {
  ok: true;
  id: string;
  task: string;
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  worktreePath: string;
  branch: string;
  warnings: string[];
}
