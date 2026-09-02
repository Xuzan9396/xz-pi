# xz-pi-btw

为 Pi 提供临时的 `/btw` 旁路会话：读取当前会话在打开窗口时已经产生的上下文，进入一个独立的全窗口聊天界面，但不把旁路问题和答案写入主会话。

## 使用

直接打开空白旁路窗口：

```text
/btw
```

打开窗口并立即提问：

```text
/btw 现在这个报错最可能是什么原因？
```

- 在 BTW 窗口底部持续输入并按 `Enter`，可以连续追问。
- `PageUp` / `PageDown` 滚动旁路记录。
- 按 `Ctrl+C` 或 `Esc` 会取消正在执行的请求并返回主会话。
- 主 Agent 正在工作时也可以调用；旁路请求不会中断或排队到主会话。
- 主会话上下文在打开窗口时冻结，不包含之后才产生的输出。
- 同一 Pi 会话内会保留最近 20 轮 `/btw` 问答；这些内容不写入磁盘，切换会话或 `/reload` 后清空。
- 旁路请求没有工具，不会读取文件、执行命令或修改项目。

## 本地安装

临时加载：

```bash
pi -e ./xz-pi-btw
```

持久登记本地目录：

```bash
pi install ./xz-pi-btw
```

源码修改后在 Pi 中执行 `/reload`。

## 为什么既是 package 又是 extension？

功能本体是一个 Pi extension（注册 `/btw` 命令和 TUI），`package.json` 只是把它包装成可通过 `pi install` 安装、更新和发布的 Pi package。开发阶段可直接 `pi -e` 加载；需要长期使用或分发时再安装 package。

## 与 Claude Code / Codex 的差异

当前版本提供接近 Codex `/side` 的全窗口连续交互，但底层仍是独立 completion，而不是 Pi SessionManager 中的另一棵持久会话树。窗口关闭后可再次执行 `/btw`，继续引用内存中的最近 20 轮旁路历史。

## 开发验证

```bash
npm install
npm run check -w xz-pi-btw
npm pack --dry-run -w xz-pi-btw
```
