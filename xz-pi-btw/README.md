# xz-pi-btw

基于 [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw) 二次开发的 Pi 旁路线程扩展。使用真实 `AgentSession` 并行讨论，不打断主 Agent，也不把旁聊内容自动塞进主模型上下文。

## 安装

```bash
pi install npm:xz-pi-btw
# 或在本仓库加载
pi -e ./xz-pi-btw
```

安装后执行 `/reload`。只加载一个 BTW 扩展：不要同时启用原版 `pi-btw` 和 `xz-pi-btw`，它们注册同一组 `/btw` 命令。

兼容 Pi `>=0.85.1 <2`。开发依赖固定为 Pi 1.1.0，使用 Node.js 22.19+。

## 快速使用

```text
/btw
/btw 这个模块的设计有哪些取舍？
/btw:ask 只读查看认证逻辑，不修改文件
/btw:summarize 把结论交给主 Agent
```

`/btw` 打开空白窗口或继续已有线程。关闭窗口不清空已完成的讨论，重新打开可继续追问；隐藏线程随当前 session branch 持久化，可在 `/reload` 后恢复。

## 大窗口、滚动与选择复制

- 默认窗口宽高约占当前终端/Herdr pane 的 **90%**。正文根据 pane 高度伸缩，不再限制为 32 行。
- `Ctrl+Shift+W` 在 90% 窗口和全宽无侧边框模式间切换，保留输入草稿。
- `PageUp/PageDown`、`↑/↓` 滚动 BTW 正文；滚到底部恢复流式自动跟随。
- **Pi 全屏模式**：鼠标悬停在窗口上滚轮滚动，左键拖选文字，由 Pi 默认自动复制。若关闭了 `fullscreenCopyOnSelect`，使用 Pi 的 `app.message.copy`（默认 `Ctrl+X`）复制选区，BTW 获得焦点时也有效。自定义 Pi copy 键绑定同样生效。
- **Pi 普通模式**：鼠标选择属于终端/Herdr。BTW 不开启额外鼠标捕获，以免阻止拖选；内部滚动使用 `PageUp/PageDown` 或方向键。普通模式下滚轮通常滚动外层 scrollback，不等于滚动 BTW 正文。
- 终端若把 Shift+拖选作为原生选择旁路，可用它进行选择；需要避免复制侧边框及周围主会话内容时先按 `Ctrl+Shift+W`。
- 不新增 `/btw:copy`、`Alt+C` 等私有复制命令或快捷键。

若需要 **滚轮滚动正文 + Pi 原生选择复制** 同时工作，使用：

```bash
pi --tui-mode fullscreen -e ./xz-pi-btw
```

无需修改 Herdr 配置；BTW 不接管或修改其剪贴板设置。

### 焦点与中止

- `Ctrl+Shift+B` 在 BTW 与主编辑器之间切换焦点，不关闭窗口。
- 标题中的 `input: BTW` / `input: main` 表示当前输入目标；BTW 获得焦点时显示真实输入光标，失焦时不显示第二个光标。
- 搭配本仓库修正版 `xz-pi-vim`，待续 `g`、`d/c/y` 和 EX 模式也可切回 BTW。
- 可用 `PI_BTW_FOCUS_KEYS` 重映射焦点键，例如 `PI_BTW_FOCUS_KEYS="f6"`。
- 请求进行中第一次 `Esc` 中止 BTW 请求并保留部分回复；再按一次关闭窗口。空闲时 `Esc` 直接关闭。
- `Ctrl+C` 优先清空 BTW 输入；输入为空时关闭窗口。

## 命令

| 命令 | 行为 |
|---|---|
| `/btw [--save] [问题]` | 继续继承主上下文的旁路线程；`--save` 额外留下可见会话笔记 |
| `/btw:new [问题]` | 清空线程，重新继承当前主会话上下文 |
| `/btw:tangent [--save] [问题]` | 不继承主会话内容的独立讨论 |
| `/btw:ask [--save] [问题]` | 继承上下文，但只开放 `read/grep/find/ls` |
| `/btw:clear` | 关闭并清空线程 |
| `/btw:inject [要求]` | 将完整讨论交给主 Agent，成功后清空线程 |
| `/btw:summarize [要求]` | 用当前 BTW 模型、无工具且思考关闭的会话总结，再交给主 Agent |
| `/btw:model [provider model api \| clear]` | 查询、设置或清除 BTW 独立模型覆盖 |
| `/btw:thinking [等级 \| clear]` | 查询、设置或清除 BTW 独立思考等级覆盖 |

不注册 `/side` 别名。BTW 输入框中的生命周期命令与外部命令语义一致；其他 slash 输入交给子会话处理。主 Agent 忙碌时注入内容通过 follow-up 排队，不中止主任务。注入/总结失败保留线程以便重试。

RPC/SDK 宿主不能打开 composer，需把问题写在命令后；完成回答会显示为可见 BTW 笔记。

## 工具与隔离边界

- `/btw` 和 `/btw:tangent` 默认开放 `read/bash/edit/write`。
- `/btw:ask` 始终只开放 `read/grep/find/ls`，从不加载扩展工具。
- 切换线程模式会清空旧线程并重建子会话，不混用工具权限。
- BTW 继承主线程模型/思考等级，也支持独立覆盖；覆盖模型缺少认证时提示并回退到主模型。
- 主上下文在创建子会话时取当前分支快照；不会每轮重新追加主 Agent 的输出。
- **并行不等于沙箱**：主 Agent 与 BTW 使用同一工作目录，都可能改同一文件。需要避免并发写入时使用 `/btw:ask`。
- 隐藏线程不进入主 LLM 上下文，但仍写入 Pi session 文件；不要把它当作不落盘的保密聊天。

### 可选扩展工具

默认不加载任何扩展。需要搜索等工具时在 agent 目录的 `btw.json`（默认 `~/.pi/agent/btw.json`）显式配置：

```json
{
  "extensions": ["npm:pi-web-access"]
}
```

已信任项目的 `.pi/btw.json` 可以覆盖全局列表；`{"extensions": []}` 禁用，省略 `extensions` 则继承。路径相对配置文件解析；支持 npm、Git 和本地文件/目录。配置在创建子会话时读取，修改后运行 `/btw:clear`。

只加载列出的扩展，独立安装到 agent 目录下的 `btw/` 缓存。父会话已经加载的同路径本地扩展会被拒绝，避免共享模块状态；重复工具名会报错。子扩展以无 UI 模式启动，关闭时执行清理，不导入其 skills、主题或快捷键。

扩展是可信代码，不是沙箱，具有当前用户的系统权限；远程包首次使用可能联网安装。请固定可信版本。需要弹窗或其他交互 UI 的工具不一定适合子会话。

## 开发

```bash
npm install
npm run check -w xz-pi-btw
npm pack --dry-run -w xz-pi-btw
npm run check
```

测试使用 Vitest、mock provider、临时 agent 目录与真实 Pi SDK/TUI，无需真实 API 密钥。项目测试包括 Pi 原生选区自动复制和关闭自动复制后的默认 copy 动作路径。

上游来源、许可和本地差异见 [UPSTREAM.md](UPSTREAM.md)。
