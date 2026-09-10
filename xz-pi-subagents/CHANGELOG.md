# xz-pi-subagents

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

- Automatically disable implicit skill inheritance when a child's resolved tool list does not include `read`; explicitly selected skills still require `read`.
- Remove Git Worktree creation, patch capture, and integration so this package only coordinates child agents.
- Reject batches with fewer than two tasks so single tasks stay in the main agent.
- Add explicit task operations, task-specific context, and validated structured result handoffs.

## 0.1.0

### Patch Changes

- f6903d2: 子 agents
