# xz-pi-worktree

一个职责单一的 Pi 扩展：管理本地 Git Worktree 的创建、检查、Patch 捕获、应用和清理。

它不启动或调度 Agent，不依赖 `xz-pi-subagents`，也不会自动响应任何 Agent 生命周期。

## 安装

要求 Node.js 22+、Pi 0.84.4+：

```bash
pi install ./xz-pi-worktree
```

安装后执行 `/reload` 或重启 Pi。

扩展以当前用户权限执行 Git 命令，不是安全沙箱。修改操作仅允许在 Pi 已信任的项目中运行。

## 使用

直接告诉 main：

> 创建一个名为 feature-api 的 Git Worktree。

扩展只注册一个模型工具 `xz_worktree`，支持以下 action：

| action | 必需参数 | 行为 |
| --- | --- | --- |
| `create` | `name` | 从当前 HEAD 创建受管 Worktree |
| `status` | `id` | 查看状态、路径以及是否有修改 |
| `list` | 无 | 列出当前仓库的受管 Worktree |
| `capture` | `id` | 捕获 tracked、staged、删除、未跟踪及二进制修改 |
| `apply` | `id` | 检查并应用 Patch 到主 checkout，成功后清理 |
| `remove` | `id` | 删除无修改的 Worktree；`force: true` 可丢弃修改 |

`cwd` 可用于 `create/list`，省略时使用 Pi 当前目录。

## 生命周期

典型流程：

1. `create` 返回稳定的 `id`、`worktreePath` 和 `executionCwd`。
2. 用户或外部程序在 `executionCwd` 中工作。
3. `capture` 生成二进制 Patch 并返回 `changedFiles`。
4. `apply` 再次捕获最新修改，要求主 checkout 的 HEAD 未变化且工作区干净。
5. Patch 通过 `git apply --check` 后应用；成功时删除 Worktree 和临时分支。
6. 冲突时不修改主 checkout，并保留 Worktree、Patch 和 manifest。

该流程不会 commit、merge 或 rebase。

## 文件位置

Worktree 默认创建在仓库同级目录：

```text
<repo-parent>/.xz-pi-worktrees/<repo>-<name>-<id前8位>
```

持久状态和 Patch 位于 Pi agent 目录：

```text
<agent-dir>/xz-pi-worktree/runs/<id>/
├── manifest.json
└── changes.patch
```

删除 Worktree 不删除 manifest 和 Patch，便于审计和恢复。

## 安全边界

- `create` 要求主仓库干净。
- `apply` 要求主仓库仍位于创建时的 HEAD，并且工作区干净。
- `remove` 默认拒绝删除有修改的 Worktree。
- 只有显式 `force: true` 才丢弃 Worktree 修改。
- Git 凭据提示被关闭，命令不会等待交互输入。
- 同一扩展实例中的 Worktree 操作串行执行，避免并行 Git 元数据修改。
- 状态目录不是长期备份；重要 Patch 应另行保存。

## 与 xz-pi-subagents 的关系

两个包完全独立：

- 不互相依赖或调用
- 不共享类型或运行时状态
- 可以单独安装、更新和卸载
- `xz-pi-subagents` 始终在当前项目目录运行，不会自动进入这里创建的 Worktree

## 开发

从仓库根目录运行：

```bash
npm run check -w xz-pi-worktree
npm pack --dry-run -w xz-pi-worktree
```
