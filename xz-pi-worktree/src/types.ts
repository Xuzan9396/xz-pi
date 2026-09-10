export type WorktreeStatus = "created" | "captured" | "applied" | "no_changes" | "conflict" | "removed";

export interface WorktreeManifest {
  version: 1;
  id: string;
  name: string;
  repoRoot: string;
  sourcePrefix: string;
  worktreePath: string;
  executionCwd: string;
  branch: string;
  baseCommit: string;
  patchPath: string;
  changedFiles: string[];
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
  cleanupError?: string;
  error?: string;
}

export interface CreateOptions {
  cwd: string;
  name: string;
}

export interface WorktreeStoreOptions {
  stateRoot: string;
  worktreeParentName?: string;
}
