# xz-pi-subagents

## 0.1.6

### Patch Changes

- dd87b42: c

## 0.1.5

### Patch Changes

- 122a08a: timeout

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

- Remove automatic child-task deadlines; tasks now run until completion, failure, cancellation, or session shutdown.
- Treat child failures as terminal results so they never pause or block a batch, and remove the fresh-Agent `c` retry flow.
- Let read-mode children inherit active `bash` and search tools alongside `read`, with an explicit no-modification behavioral contract.
- Add `/agent_show` to restore a hidden task panel and clarify that double `x` cancels only the selected child.
- Automatically disable implicit skill inheritance when a child's resolved tool list does not include `read`; explicitly selected skills still require `read`.
- Remove Git Worktree creation, patch capture, and integration so this package only coordinates child agents.
- Reject batches with fewer than two tasks so single tasks stay in the main agent.
- Add explicit task operations, task-specific context, and validated structured result handoffs.

## 0.1.0

### Patch Changes

- f6903d2: 子 agents
