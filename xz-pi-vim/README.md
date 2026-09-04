# xz-pi-vim

`xz-pi-vim` 是一个本地 Pi package，为 Pi 的终端输入区提供 Vim 风格模态编辑。

本项目参考了 [lajarre/pi-vim](https://github.com/lajarre/pi-vim) 的模块划分和交互思路，但首版采用独立、精简的状态机实现。

## 安装

临时加载：

```bash
pi -e /Users/admin/go/tmp_xz/xz-pi-vim
```

持久安装：

```bash
pi install /Users/admin/go/tmp_xz/xz-pi-vim
```

修改源码后，在 Pi 中执行 `/reload`。

## 模式

- `INSERT`：正常输入，`Esc` 进入 NORMAL。
- `NORMAL`：执行移动、操作符和编辑命令。
- `VISUAL`：字符选区。
- `V-LINE`：整行选区。
- `EX`：执行退出、Pi slash command 或 shell command。
- INSERT 模式支持在行中空白后输入 `/`，立即模糊匹配 Pi 命令。

## 首版按键

### 移动

```text
h j k l
0 ^ $
w b e
gg G
{count}{motion}
```

### 编辑

```text
i a I A o O
x X s S
D C
J
u Ctrl+r
```

### 操作符与寄存器

```text
d c y
dd cc yy
dw cw yw
p P
```

支持前置计数以及操作符后的计数，例如 `3dd`、`2dw`、`2d3w`。

### Visual

- `v`：进入或退出字符选区。
- `V`：进入或退出整行选区。
- `d/x`：删除。
- `c`：修改。
- `y`：复制到 unnamed register。

### 行中 Slash Command 补全

INSERT 模式下，`/` 不再局限于行首。只要它位于空白之后，就会立即打开 Pi 命令模糊匹配：

```text
请帮我 /          展示可用命令
请帮我 /rel       匹配 /reload
第二行 /tree      多行输入中同样生效
```

URL 和已包含后续 `/` 的路径不会作为行中命令 token 匹配。关闭该功能可设置 `inlineSlashCompletion: false`。

### Tool / MCP Tag 引用

INSERT 模式下输入 `$` 可模糊搜索 Pi 当前注册的能力。空查询和搜索结果始终按 MCP → Package → Tool 排序：

```text
◆ context7_mcp       MCP · 2 tools
◇ xz-pi-websearch    PACKAGE · 2 tools
· web_search         TOOL · Search the web
```

```text
帮我用 $context
```

选择 MCP、Package 或具体 Tool 后，`$context` 会替换成对应名称的彩色 Tag。`$` 和列表图标只是触发/显示符，不会保留或提交给模型。MCP Tag 关联该 Server 下的工具，Package Tag 关联该包注册的工具，Tool Tag 只关联单个工具。

Tag 是原子编辑单元：在 Tag 内或边缘使用 Backspace、Delete、`x`、`X`、`d`、`c` 或 Visual 删除时会删除整个 Tag。在 Tag 内插入字符会令其退化为普通文本。复制得到的是不含颜色控制符的纯名称。

提交时，仍存在的 Tag 所关联工具会按配置自动启用，并提示模型在适合时优先使用；工具不会被强制直接调用。Pi 暂无公开的 MCP/Package 列表 API，因此目录从 `pi.getAllTools().sourceInfo` 聚合，只展示当前已注册的 MCP，以及实际提供 Tool 的 Package。

### EX

```text
:q                 安全退出，输入区非空时拒绝
:q!                强制退出
:tree              调用 Pi 的 /tree
:model <name>      调用 Pi 的 /model
:!git status       调用 Pi shell，并保留草稿
:!!git status      调用不进入上下文的 Pi shell
```

`:s`、`:w` 等完整 Vim 文件命令不在首版范围内。

## 设置

在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 中配置：

```json
{
  "xzPiVim": {
    "startInNormal": false,
    "cursorShape": true,
    "modeColors": true,
    "exCommand": true,
    "inlineSlashCompletion": true,
    "toolReferences": true,
    "activateReferencedTools": true,
    "highlightToolReferences": true
  }
}
```

项目配置覆盖全局配置。

## 开发验证

```bash
npm install
npm run check
pi -e /Users/admin/go/tmp_xz/xz-pi-vim
```

## 当前差异

- 不实现宏、搜索、`.` 重复、命名寄存器和块选择。
- 未同步系统剪贴板，避免在 Pi package 隔离模块根中动态解析宿主包。
- Vim 操作使用扩展自己的 undo/redo 历史；Pi 原生 INSERT 输入在离开 INSERT 时合并为一个撤销单元。
- 首版目标是常用终端编辑体验，不承诺与 Neovim 逐键完全一致。
