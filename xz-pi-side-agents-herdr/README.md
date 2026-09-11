# xz-pi-side-agents-herdr

Herdr-native asynchronous side agents for Pi. It keeps the command/tool surface of `pi-side-agents`, but maps each child Git worktree to a visible Herdr pane instead of a tmux window.

## Requirements

- Node.js 22+
- Pi 0.84.4+
- Herdr 0.9+
- A Git repository
- Pi must run inside Herdr (`HERDR_ENV=1`)

Do not enable this package together with `pi-side-agents`; both register the same commands and tools.

## Install

```bash
pi install ./xz-pi-side-agents-herdr
```

Restart Pi, then initialize the current repository:

```text
/skill:agent-setup
```

The setup skill defaults `mainBranch` to the branch checked out during initialization. A different local branch can be specified in the setup request.

## Commands

```text
/agent [-model <provider/id>] [-mode <name>] <task>
/agents
/agent-resume
```

Tools exposed to the parent agent:

```text
agent-start
agent-check
agent-wait-any
agent-send
```

## Model

A child is represented by:

```text
Agent:    fix-auth-0001
Branch:   side-agent/fix-auth-0001
Worktree: ../repo-agent-fix-auth-0001
Pane:     Herdr pane id such as w1:p4
```

The worktree starts from the configured integration branch. The first child opens in a narrow right column (`mainPaneRatio` defaults to `0.72`, so main stays largest). Additional children split the largest child pane downward, keeping a balanced stack on the right without shrinking main again. The extension preserves focus, runs project bootstrap in the child pane, starts Pi through `herdr agent start`, and submits the task through `herdr agent prompt`.

## `/quit` safety

On child `/quit`, cleanup occurs only when both conditions hold:

1. `git status --porcelain` is empty;
2. the child branch has no commit missing from the configured integration branch.

When safe, the child exits to its shell and asks for one final arbitrary-key confirmation in the Herdr pane. After a key is pressed, a detached janitor removes the worktree, deletes the already-merged topic branch, closes the pane, and removes the registry entry.

If uncommitted or unmerged work exists, cleanup is skipped. The worktree and pane remain, the registry status becomes `paused`, and `/agent-resume` can reopen the child session.

## Local state

```text
.pi/side-agents-herdr/config.json
.pi/side-agents-herdr/registry.json
.pi/side-agents-herdr/registry.lock
.pi/side-agent-start.sh
.pi/side-agent-finish.sh
.pi/side-agent-skills/
```

These files are local runtime configuration and should not be committed.
