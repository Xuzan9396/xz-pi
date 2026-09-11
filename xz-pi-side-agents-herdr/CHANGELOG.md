# Changelog

## 0.1.0

### Patch Changes

- 385169d: heder 兼容

## 0.1.0

- Initial Herdr-native side-agent implementation.
- Added `/agent`, `/agents`, `/agent-resume` and orchestration tools.
- Added one-worktree-per-pane lifecycle and guarded `/quit` cleanup.
- Added project initialization skill with configurable integration branch.
- Fixed bootstrap completion detection racing with echoed shell commands.
- Explicitly loads the lifecycle extension in locally launched children.
- Added an arbitrary-key confirmation before deleting a merged worktree and closing its pane.
- Reconciles stale registry records when their worktree and pane are already gone, while preserving unmerged branches for resume.
