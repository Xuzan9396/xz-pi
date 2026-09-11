---
name: agent-setup
description: Initialize or update project-local configuration for xz-pi-side-agents-herdr, including the integration branch and lifecycle scripts
---

# Herdr Side-Agent Setup

Initialize this repository for `xz-pi-side-agents-herdr`. Everything created below is local runtime configuration under `.pi/`; do not commit it.

## 1. Determine configuration

Find the repository root and current branch:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
CURRENT_BRANCH=$(git -C "$GIT_ROOT" branch --show-current)
```

Use the current branch as the default integration branch. If the user supplied a branch in the skill arguments, use that instead. Verify the branch exists with:

```bash
git -C "$GIT_ROOT" show-ref --verify "refs/heads/$MAIN_BRANCH"
```

Ask before overwriting any existing files. Ask whether the project needs bootstrap commands such as dependency installation or copying local environment files.

Keep runtime files out of Git status without changing the tracked `.gitignore`. Ensure the shared Git exclude file contains these lines exactly once:

```gitignore
.pi/side-agents-herdr/
.pi/side-agent-start.sh
.pi/side-agent-finish.sh
.pi/side-agent-skills
```

Resolve the shared exclude path with `git -C "$GIT_ROOT" rev-parse --git-path info/exclude`, create its parent directory if needed, and append only missing lines. This exclude is shared by the main checkout and linked worktrees.

## 2. Create `.pi/side-agents-herdr/config.json`

```json
{
  "version": 1,
  "mainBranch": "MAIN_BRANCH_VALUE",
  "mainPaneRatio": 0.72,
  "childSplitRatio": 0.5,
  "cleanupOnQuit": true
}
```

The first child opens on the right. `mainPaneRatio: 0.72` keeps the main pane at roughly 72% width. Additional children split the largest child pane downward at `childSplitRatio`, producing a balanced stack in the right column without shrinking the main pane.

## 3. Create executable `.pi/side-agent-start.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="${1:?parent repository is required}"
WORKTREE="${2:?worktree is required}"
AGENT_ID="${3:?agent id is required}"
MAIN_BRANCH="MAIN_BRANCH_VALUE"
BRANCH="$(git -C "$WORKTREE" branch --show-current)"

if [[ -z "$BRANCH" || "$BRANCH" == "$MAIN_BRANCH" ]]; then
  echo "[side-agent-start] invalid child branch: $BRANCH"
  exit 1
fi

echo "[side-agent-start] agent=$AGENT_ID branch=$BRANCH main=$MAIN_BRANCH"
echo "[side-agent-start] base=$(git -C "$WORKTREE" rev-parse --short HEAD)"

# Add project-specific bootstrap commands below this line.
```

Append bootstrap commands agreed with the user, then run `chmod +x`.

## 4. Create executable `.pi/side-agent-finish.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="${PI_SIDE_PARENT_REPO:?PI_SIDE_PARENT_REPO is required}"
MAIN_BRANCH="MAIN_BRANCH_VALUE"
BRANCH="$(git branch --show-current)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[side-agent-finish] commit or discard local changes first"
  exit 2
fi

LOCK_DIR="$PARENT_ROOT/.pi/side-agents-herdr/merge.lock"
ACQUIRED=0
for _ in $(seq 1 120); do
  if mkdir "$LOCK_DIR" 2>/dev/null; then ACQUIRED=1; break; fi
  sleep 1
done
if [[ "$ACQUIRED" != 1 ]]; then
  echo "[side-agent-finish] timed out waiting for merge lock"
  exit 3
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

git rebase "$MAIN_BRANCH"
git -C "$PARENT_ROOT" checkout "$MAIN_BRANCH"
git -C "$PARENT_ROOT" merge --ff-only "$BRANCH"
echo "[side-agent-finish] merged $BRANCH into $MAIN_BRANCH"
```

Run `chmod +x`.

## 5. Create `.pi/side-agent-skills/finish/SKILL.md`

```markdown
---
name: finish
description: Finish a Herdr side-agent branch after explicit user approval by rebasing and fast-forwarding it into the configured integration branch
---

# Finish side-agent work

Only after explicit approval such as “LGTM, merge”:

1. Ensure all intended changes are committed.
2. Run `.pi/side-agent-finish.sh`.
3. Resolve any rebase conflict and rerun the script.
4. Report the landed commits.
5. Run `/quit` when done. After Pi exits, press any key at the pane confirmation prompt; the extension then removes the clean, fully merged worktree and closes its Herdr pane.

If `/quit` detects uncommitted changes or commits not merged into the integration branch, it preserves both the worktree and pane and reports why cleanup was skipped.
```


## 6. Report

List files created, updated, or skipped. Remind the user:

- Start: `/agent <task>`
- Inspect: `/agents`
- Resume a preserved unfinished agent: `/agent-resume`
- Local `.pi/side-agent-*` and `.pi/side-agents-herdr/` files must remain untracked.
