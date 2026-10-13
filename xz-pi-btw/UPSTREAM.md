# 上游来源

- 项目：[dbachelder/pi-btw](https://github.com/dbachelder/pi-btw)
- 固定提交：`d0d1ba5404b66058c501ed3e286733660df56aa9`
- 基线版本：`0.7.1`
- 许可：MIT，原作者 Dan Bachelder；原始版权声明见 [LICENSE](LICENSE)。
- 获取方式：GitHub MCP 核验源码及提交后，从该提交的 GitHub source archive 导入，不包含上游 `.git`、依赖目录或锁文件。

## 移植范围

移植真实子会话、隐藏线程、命令族、模型/思考覆盖、可选扩展工具及三组上游测试。旧 `xz-pi-btw` 的 completion 实现和对应测试已移除。

## 本地差异

1. 保留 `xz-pi-btw` 包名、monorepo workspace 和 Changesets 发布信息。
2. 按用户要求移除 `/side` 别名；只注册 `/btw` 命令族。
3. 默认窗口宽高从 78% 调整到 90%，移除 32 行高度上限，读取实际 pane 尺寸；极小 pane 保留可达的输入框。
4. 通过 Pi 的 normalized `handleMouse` 处理滚轮，只消费 wheel，不捕获鼠标拖选；旧宿主收到原始鼠标包时只处理滚轮，不把鼠标序列输入 composer。
5. 不再在普通模式主动开启/关闭终端鼠标 reporting，选择所有权交给终端/Herdr。普通模式以键盘滚动正文；全屏模式支持滚轮与默认拖选自动复制并存。
6. BTW 获取焦点时，用当前 `app.message.copy` 键绑定调用宿主 `copyActiveSelectionToClipboard`，不增加私有复制命令，也不复制主会话的最后回答。
7. 增加真实 Pi TUI 的拖选、自动复制、默认 copy、滚轮路由测试，以及窗口尺寸和输入兼容回归。
8. 中文使用文档，开发依赖固定 Pi 1.1.0；宿主 peer 范围保持 `>=0.85.1 <2`。

## 后续同步

按固定上游提交比较 `extensions/` 和 `tests/`，保留本地选择/滚动/尺寸行为及无 `/side` 的约束。上游更新不应覆盖本地回归断言或版权声明。
