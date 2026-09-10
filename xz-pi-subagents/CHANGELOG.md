# xz-pi-subagents

## 0.1.4

### Patch Changes

- 08bbe01: worktree

## 0.1.3

### Patch Changes

- 92f4b77: agent

## 0.1.2

### Patch Changes

- 2075e89: min

## 0.1.1

### Patch Changes

- dc1b449: worktree

## Unreleased

- Remove automatic child-task deadlines; tasks now run until completion, failure handling, cancellation, or session shutdown.
- In TUI mode, pause failed tasks and allow `c` in task detail to retry with a fresh Agent using the same task configuration and current workspace.
- Add `/agent_show` to restore a hidden task panel and clarify that double `x` cancels only the selected child.
- Automatically disable implicit skill inheritance when a child's resolved tool list does not include `read`; explicitly selected skills still require `read`.
- Remove Git Worktree creation, patch capture, and integration so this package only coordinates child agents.
- Reject batches with fewer than two tasks so single tasks stay in the main agent.
- Add explicit task operations, task-specific context, and validated structured result handoffs.

## 0.1.0

### Patch Changes

- f6903d2: 子 agents
