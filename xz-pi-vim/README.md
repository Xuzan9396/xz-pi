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
    "exCommand": true
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
