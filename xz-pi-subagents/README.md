# xz-pi-subagents

一个专注于 **main 分派任务 → 多个子 agent 执行 → main 等待汇总** 的 Pi 扩展。

只有一个模型工具 `xz_subagents_run`，没有角色管理中心、后台守护、递归 agent、记忆或复杂工作流。任务运行时，输入框下方自动展示可交互列表，不需要斜杠命令。

## 安装

要求 Node.js 22+、Pi 0.84.4+（使用 Pi npm 安装中的 CLI）。

从本仓库根目录安装本地包：

```bash
pi install ./xz-pi-subagents
```

在 Pi 中执行 `/reload` 或重启。包发布到 npm 后也可使用 `pi install npm:xz-pi-subagents`。

扩展、skills 和工具均以当前用户权限运行。**独立进程和工具白名单不是沙箱**，安装前请检查源码。

## 平时怎么用

直接向 main 提出需求：

> 用两个 agent 分别阅读 src/auth.ts 和 test/auth.test.ts，分析登录实现与测试覆盖，等他们完成后你汇总。

main 会调用工具创建任务，不需要你写 JSON，也不需要先创建角色。任务 `name` 是这次运行的显示名称，不是预先注册的 agent 类型。

```text
──────────────────────────────────────────────
> 主输入框
──────────────────────────────────────────────
↓ 查看子任务（空输入框）
  main  等待子任务 · 1/2
  ● auth-scout   运行中 · 18s · 1200 tokens  read
  ✓ test-review 已完成 · 12s · 800 tokens   检查测试
```

显示真实状态、耗时、当前工具，以及已结束模型消息报告的 token 用量；未报告用量时显示 0，不估算完成百分比。

### 键盘操作

| 位置 | 按键 | 行为 |
| --- | --- | --- |
| 空输入框 | `↓` | 打开或重新显示当前批次列表，先选中 main |
| 列表 | `↑` / `↓` | 选择任务 |
| 列表 | `Enter` | 子任务：打开实时详情；main：回输入框 |
| 列表 / 详情 | `x`，3 秒内再按 `x` | 确认取消当前子任务；其他任务继续 |
| 详情 | `↑` / `↓`、`PgUp` / `PgDn` | 滚动任务说明、输出、工具参数和结果 |
| 详情 | `Home` / `End` | 顶部 / 恢复跟随最新输出 |
| 详情 | `Esc` | 返回列表，不取消任务 |
| 列表 | `Esc` | 隐藏整个底部面板，返回输入框，不取消任务 |
| 列表选中 main | `↑` | 退出列表导航，回输入框，面板仍显示 |
| 主输入框 | Pi 的中止键（默认 `Esc`） | 中止 main 当前操作，并取消本批次全部子任务 |

普通文字输入会退出列表导航并交还现有编辑器。补全菜单、其他对话框、Vim 的 `h/j/k/l` 与 ex/visual 模式不被接管。`xz-pi-vim` 中，输入框的 `Esc` 先遵循 Vim 自己的模式切换规则。

**隐藏面板 ≠ 取消任务 ≠ 删除日志。** 面板隐藏后任务仍然执行，状态更新不会自动把它弹回来；空输入框按 `↓` 可重新打开。新批次开始会自动显示面板。

从 main 中止整批后，等执行器完成停止/回收才自动隐藏面板。如果正在阅读详情，或出现了失败（例如无法确认进程回收），保留界面供检查；详情 `Esc` 返回列表，再按 `Esc` 隐藏。

已结束任务的内存记录保留到下一批次或会话重载，隐藏面板不会清空它们。详情默认只显示最近约 60 KB 的对话，较早输出可从事件文件查看。关闭详情不关闭子进程；任务完成后详情也不会自动消失。

## 模型工具

main 调用示例（不是用户命令）：

```javascript
xz_subagents_run({
  tasks: [
    { name: "auth-scout", operation: "inspect", task: "读取 src/auth.ts，分析登录流程，不修改文件。" },
    { name: "test-review", operation: "review", task: "读取 test/auth.test.ts，检查边界情况覆盖。" }
  ],
  context: "重点关注 token 过期和并发刷新。",
  concurrency: 4,
  timeoutSeconds: 600
})
```

- 每批 2–8 个任务；每个 main 会话一次只接受一批。只有一个任务时必须由 main 直接执行，禁止启动子 agent。必须把并行任务放进**同一次调用**。
- `concurrency`：1–4，默认 4；适用于两种工具模式，不再仅限 read 任务。
- `operation`：`general/inspect/research/implement/test/review/integrate`，用于约束职责和结构化结果；省略为兼容模式 `general`。
- 任务级 `context` 会追加到批次公共 `context` 后，只发给该任务。
- `isolation: "worktree"` 只允许 `mode: "write", operation: "implement"`；main 根据是否存在并行代码修改自行选择，调研、查询和普通测试不使用 worktree。
- `requireChanges` 仅用于 worktree，默认 `true`；允许实现任务合法无改动时可显式设为 `false`。
- `exclusive`：每个任务可设置，默认 `false`。设为 `true` 时先等待本批次活动任务结束，再独占执行；后续任务等待它完成，不插队。
- `timeoutSeconds`：每个任务从启动执行器开始的进程运行时限，默认 600，最大 1800；排队不计入。
- 所有任务进入完成、失败、取消或超时状态后才返回，结果保持输入顺序。某个任务失败不会丢弃其他任务的结果。
- **main 模型等待，但 Node 事件循环不阻塞**，所以 UI 仍可刷新、打开详情、取消任务。
- 有依赖的任务由 main 分轮安排，上一轮结果作为下一轮 `context`。

### 工具权限与并发

| 模式 | 默认工具 | 调度 |
| --- | --- | --- |
| `mode: "read"`（默认） | main 当前启用的 `read/grep/find/ls` 的交集 | 默认并行 |
| `mode: "write"` | main 当前启用的工具，剔除已知 agent 调度工具 | 默认并行 |

`tools` 可以进一步缩小白名单，不能增加 main 当前未启用的工具。`tools: []` 禁用所有工具。

默认 Pi 可能只启用了 `read/bash/edit/write`，此时 read 模式只有 `read`。main 应先定位文件并传入明确路径；需要 shell、实现、验证命令、MCP 或其他扩展时，选择 write 模式。也可以由用户先在主 Pi 中启用所需的只读内置工具。

**mode 只决定工具访问，不决定是否串行。** 独立网页调研可以使用 write 模式和精简工具白名单，并行执行：

```javascript
xz_subagents_run({
  tasks: [
    { name: "ios-native", mode: "write", operation: "research", task: "搜索 XCUITest/Appium 方案，不修改文件或设备。", tools: ["web_search", "fetch_content"], skills: [] },
    { name: "ios-light", mode: "write", operation: "research", task: "搜索 Maestro/simctl 方案，不修改文件或设备。", tools: ["web_search", "fetch_content"], skills: [] }
  ],
  concurrency: 2
})
```

控制同一浏览器/设备、执行非隔离写操作等有冲突的任务，应由 main 显式设置 `exclusive: true`。只读任务需要稳定工作区快照时也可以指定独占。独占只覆盖**本批次**，不覆盖其他 Pi 会话或外部进程。

### 并行实现与自动 Patch 集成

需要并行写代码时，main 可以显式选择严格 worktree：

```javascript
xz_subagents_run({
  tasks: [
    { name: "api", mode: "write", operation: "implement", isolation: "worktree", task: "只修改 src/api/** 并完成 API。", context: "接口契约：……" },
    { name: "ui", mode: "write", operation: "implement", isolation: "worktree", task: "只修改 src/ui/** 并完成页面。", context: "接口契约：……" }
  ],
  concurrency: 2
})
```

- 主 Git checkout 必须干净；否则 worktree 任务启动失败，不会退回共享目录。
- worktree 位于仓库上级的 `.xz-pi-worktrees/<仓库>-<任务>-<短ID>`。
- 子任务不能 commit/merge/rebase；执行器捕获相对共同 base commit 的二进制 Patch，包含 tracked、staged、删除和未跟踪文件。
- main 等全部子进程结束后，执行器按任务输入顺序先 `git apply --check`，再把 Patch 应用到主 checkout。这里的“集成”是应用未暂存 Patch，**不会自动提交 Git commit**。
- Patch 成功应用或任务合法无改动后，自动删除 worktree 和临时分支；冲突、捕获失败或失败任务存在改动时保留 worktree、Patch 和 `handoff.json` 供检查。
- 一个 Patch 冲突不会阻止后续独立 Patch 尝试集成。main 最终收到每个任务的 `applied/conflict/preserved/no_changes` 状态。
- 调研、查询、Review 和普通测试不创建 worktree；它们继续在项目 cwd 并行。非 worktree 写操作仍可能冲突，应使用 `exclusive`。

`read` 模式按工具名限制。若受信任扩展覆盖了同名内置工具，仍执行该扩展实现；它不是文件系统只读沙箱。

## Skills、MCP 与上下文

### Skills

- 默认转发 main 当前加载的 skill 文件目录信息，子 agent 按需读取。
- `skills: ["code-review"]` 只选择指定 skill，`skills: []` 关闭。
- 找不到指定 skill 或无法加载其文件时报错。
- 使用 skills 必须保留 `read` 工具。
- 不把全部 skill 正文复制进每个子代理的上下文。

### MCP 与扩展

子 Pi 使用相同的 cwd、Pi agentDir 和环境变量，按 Pi 规则重新加载全局/已信任项目的配置与扩展。main 当前工具来源中的可定位扩展文件也会显式转发，覆盖常见的临时 `-e` 工具扩展。

例如使用已经安装、配置好的 `pi-mcp-adapter`：

```javascript
xz_subagents_run({
  tasks: [
    {
      name: "docs-api", mode: "write", operation: "research",
      task: "通过已配置的 context7 MCP 查询这个库的 API，返回来源。",
      tools: ["read", "mcp"], skills: []
    },
    {
      name: "docs-migration", mode: "write", operation: "research",
      task: "通过已配置的 context7 MCP 查询这个库的迁移指南，返回来源。",
      tools: ["read", "mcp"], skills: []
    }
  ]
})
```

`mcpScript`、namespace proxy、direct tools 同样按**实际注册的工具名**加入 `tools`。所需工具必须已在 main 启用，并能在子 Pi 初始化时注册。direct tools 尚未进入缓存/注册表时会明确失败，不会自动扩大工具权限。

重要边界：

- 继承的是配置和可加载文件，不是父进程连接、临时授权或内存中的 MCP server。
- 仅通过 SDK 内存注入的工具、动态 provider、临时 API key，以及无法定位来源文件的扩展，不保证能在子进程重建。必要能力缺失会失败。
- MCP 的审批规则保持不变。headless 子进程不能弹审批框，需要审批的调用会拒绝；不会自动批准或开启原本禁用的 server。
- 多个代理操作同一个浏览器、设备或远端服务并不天然安全：main 必须为冲突任务选择 `exclusive: true`。独立的只读查询无需因使用 MCP 而强制串行。
- 不额外安装 MCP adapter，不复制认证信息到任务文件，也不修改用户 settings/mcp 配置。

### 模型与提示词

默认使用 main 当前模型和 thinking；任务可指定 `model: "provider/modelId"`。新进程从已有 Pi 配置/环境解析认证。

子代理默认是新对话，**不复制 main 聊天历史和运行时系统提示词**。加载标准 Pi 系统提示词、适用的 AGENTS.md / CLAUDE.md、所选 skills，再追加子任务职责。main 提供的批次背景用顶层 `context` 传入，任务私有背景用 `tasks[].context` 传入。未信任项目不会因委派而自动获得信任；Pi 的上下文文件仍遵循其原有加载规则。

除兼容模式 `general` 外，子代理必须在最终回复附带 `XZ_SUBAGENT_RESULT` JSON，包含状态、摘要、实际命令/退出码、测试证据、发现、假设和阻塞项。原始全文仍写入 `output.md`，结构化结果写入 `result.json` 并返回 main；缺失或非法结构化结果会把任务标记失败，避免仅凭自然语言“已完成”进入下一阶段。

## 输出、取消与清理

- main 收到的汇总最多 50 KB / 2000 行，单任务按批次数均分正文预算；截断会提示读取文件。
- 每个任务在系统临时目录生成独立的 `xz-pi-subagent-*` 私有目录：`output.md`、`events.jsonl`、`result.json`、`stderr.log`，以及启动配置和职责提示词。worktree 任务另有 `changes.patch` 和 `handoff.json`。
- 子进程使用 `--no-session`：这些产物不是可通过 `/resume` 续聊的原生 Pi 子会话。当前批次 UI 记录在内存中，不跨 Pi 重启恢复；main 的返回摘要和路径随主会话工具结果保存（主会话开启保存时）。
- 输出文件不存入仓库，也不写进 npm 包。目录和文件限制为当前用户访问。
- 每个事件流最多 32 MiB，单行 JSON 最多 4 MiB；超限会停止任务并标记失败。stderr 仅保留最后 16 KB。
- 取消先终止进程树，宽限后强制结束，不能仅凭“发出了 kill”就认为任务完成。
- reload、切换会话和退出时回收本批次任务。若 main 意外退出，子进程的父进程存活检测会请求停止。
- 关闭面板、关闭详情或取消任务都不会主动删除日志。临时目录（macOS 通常是 `/var/folders/.../T/`）可能在系统清理或重启时被清除，但不是保证每次重启都删除，也不保证长期保留。重要结果请另存到项目目录。
- 本包不自动删除历史产物。日志可能包含任务和工具的敏感输出，不要直接公开。
- 进程树清理是尽力而为，不保证回收自行 daemonize/逃逸的第三方进程，也不能撤销远程任务。macOS 上已验证取消；Windows 有 `taskkill /T` 分支，尚未做真实 Windows 终端验收。

## 开发与测试

仓库根目录：

```bash
npm install --ignore-scripts
npm run check -w xz-pi-subagents
npm pack --dry-run -w xz-pi-subagents
```

测试包含：两种模式默认并发、显式独占、批量等待、失败隔离、取消竞态、进程超时、TERM 忽略后的强制回收、JSON/UTF-8 分帧、面板隐藏/重开/新批次、取消后自动隐藏与日志保留、UI 导航、宽度限制、Vim 兼容，以及真实 Pi CLI 配合本地模拟模型的集成测试（两个 write 模式子进程调用搜索 fixture，验证它们实际重叠运行）。集成测试不使用真实 API key，也不消耗模型费用。

可选真实 MCP adapter 验证（只访问测试创建的本地 stdio MCP，不读取个人 MCP 配置）：

```bash
XZ_TEST_MCP_ADAPTER="$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts" \
  npm test -w xz-pi-subagents
```

使用另一份 Pi 安装验证 CLI 兼容性：设置 `XZ_TEST_PI_PACKAGE_DIR` 为该 `@earendil-works/pi-coding-agent` 的包根目录。

手动终端验收可运行 `test/fixtures/ui-host.mjs`（参数为仓库绝对路径）；它输出临时 `agentDir` 和 `cwd`。在另一个终端以 `PI_CODING_AGENT_DIR=<agentDir> PI_OFFLINE=1 pi --model fixture/model --thinking off` 从该 cwd 启动，输入任意任务即可得到两个持续输出的子代理。fixture 同时加载本仓库的 Vim 扩展。

## 参考

- [pi-subagents-lite](https://github.com/ZiChuanLan/pi-subagents-lite)：底部列表、键盘导航、实时详情与取消交互。
- [pi-subagents](https://github.com/nicobailon/pi-subagents)：资源加载边界、执行生命周期和结果产物。
- Pi 官方 subagent 示例：独立 CLI 子进程与 JSON 事件流。

独立实现精简执行器与界面，没有把上述完整框架作为运行依赖。使用 Pi 扩展接口；补全焦点兼容层只读检查当前编辑器的 `autocompleteState`（Pi 暂无公开 getter），遇到未知布局会放弃接管按键，不修改编辑器内部状态。
