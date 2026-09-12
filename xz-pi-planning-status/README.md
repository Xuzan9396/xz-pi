# xz-pi-planning-status

在 Pi Footer 的 MCP 状态前展示当前项目 `.xz_planning/STATE.md` 中的最新计划。

```text
当前计划：36 · TG机器人加安全额度申请交互命令
```

## 行为

- 优先读取 `## 当前进度` 下的 Markdown 表格。
- 当前进度没有有效计划时，回退读取 `## 已归档` 下的最新计划。
- 按数字分段比较版本号，例如 `35.3 < 35.10 < 36`。
- 文件不存在、不可读或无法解析时保持空白，不弹出错误。
- 监听 `.xz_planning/STATE.md`，文件变化后自动刷新。
- 默认开启；开关保存在 `~/.pi/agent/xz-planning-status.json`，由所有项目共享。
- 与其他 Footer 状态显示在同一行，并排在 MCP 状态之前；长内容由 Pi 根据终端宽度截断。

## 安装

从 npm 全局安装到 Pi：

```bash
pi install npm:xz-pi-planning-status
```

本地开发安装：

```bash
pi install /Users/admin/go/src/myai/xz-pi/xz-pi-planning-status
```

修改源码后执行 `/reload`。

## 命令

```text
/xz          切换展示状态
/xz on       开启展示
/xz off      关闭展示
/xz status   查看状态和当前解析结果
```

## 开发验证

```bash
npm install
npm run check -w xz-pi-planning-status
```
