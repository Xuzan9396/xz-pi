# xz-pi

[![CI](https://github.com/Xuzan9396/xz-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/Xuzan9396/xz-pi/actions/workflows/ci.yml)
[![Release](https://github.com/Xuzan9396/xz-pi/actions/workflows/release.yml/badge.svg)](https://github.com/Xuzan9396/xz-pi/actions/workflows/release.yml)

`xz-pi` 是一个 [Pi](https://github.com/badlogic/pi-mono) 扩展与技能集合。每个子包都独立发布到 npm，可以按需安装、更新和卸载，不会因为安装其中一个而启用其他包。

> [!WARNING]
> Pi 扩展会以当前用户权限执行代码，技能也可能引导 Agent 执行系统命令。安装前请先检查源码。

## 环境要求

- 已安装 [Pi](https://github.com/badlogic/pi-mono)
- Node.js 18 或更高版本
- npm 可访问 npm Registry

确认环境：

```bash
pi --version
node --version
npm --version
```

## 包列表

| 包 | 功能 | npm |
| --- | --- | --- |
| [`xz-pi-playwright-cli`](./xz-pi-playwright-cli) | 提供 Microsoft Playwright CLI 技能，用于浏览器自动化与测试 | [![npm](https://img.shields.io/npm/v/xz-pi-playwright-cli)](https://www.npmjs.com/package/xz-pi-playwright-cli) |
| [`xz-pi-websearch`](./xz-pi-websearch) | 提供精简的 `web_search` 和 `fetch_content` 工具 | [![npm](https://img.shields.io/npm/v/xz-pi-websearch)](https://www.npmjs.com/package/xz-pi-websearch) |
| [`xz-pi-vim`](./xz-pi-vim) | 为 Pi 终端输入区提供 Vim 风格模态编辑 | [![npm](https://img.shields.io/npm/v/xz-pi-vim)](https://www.npmjs.com/package/xz-pi-vim) |

## 快速安装

只安装需要的子包：

```bash
# Vim 模态编辑
pi install npm:xz-pi-vim

# 搜索和网页内容提取
pi install npm:xz-pi-websearch

# Playwright CLI 技能
pi install npm:xz-pi-playwright-cli
```

安装后可通过以下命令确认 Pi 已登记对应包：

```bash
pi list
```

如果 Pi 已经在运行，请执行 `/reload` 或重启 Pi。

### 项目级安装

默认安装会写入用户配置 `~/.pi/agent/settings.json`。使用 `-l` 可将包安装到当前项目，并写入 `.pi/settings.json`：

```bash
pi install -l npm:xz-pi-vim
```

项目首次加载时需要先确认信任该项目。

### 安装指定版本

```bash
pi install npm:xz-pi-vim@0.1.0
```

显式指定版本后，该包会被固定在对应版本，不会被普通批量更新自动升级。

## 子包说明

### xz-pi-playwright-cli

提供 `/skill:playwright-cli` 技能。使用前还需要安装 Microsoft Playwright CLI：

```bash
npm install -g @playwright/cli@latest
playwright-cli --help
```

安装 Pi 包：

```bash
pi install npm:xz-pi-playwright-cli
```

验证浏览器自动化环境：

```bash
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli close
```

详细说明见 [`xz-pi-playwright-cli/README.md`](./xz-pi-playwright-cli/README.md)。

### xz-pi-websearch

提供两个工具：

- `web_search`：通过 OpenAI/Codex 搜索并返回带来源的精简答案
- `fetch_content`：提取网页正文，并针对 GitHub 仓库、文件、PR 和 Issue 提供专门处理

要求满足以下任一认证方式：

- 在 Pi 中通过 `/login` 登录 OpenAI Codex；或
- 设置 `OPENAI_API_KEY`

可选安装 `gh`，以支持私有 GitHub 仓库和更完整的 PR/Issue 数据。

```bash
pi install npm:xz-pi-websearch
```

> `xz-pi-websearch` 与 `pi-web-access` 都会注册 `web_search` 和 `fetch_content`。请勿同时启用；切换前可执行 `pi remove npm:pi-web-access`。

详细说明见 [`xz-pi-websearch/README.md`](./xz-pi-websearch/README.md)。

### xz-pi-vim

为 Pi 输入区提供 `INSERT`、`NORMAL`、`VISUAL`、`V-LINE` 和 `EX` 模式，支持常用移动、编辑、操作符、寄存器及 EX 命令。

```bash
pi install npm:xz-pi-vim
```

可在 `~/.pi/agent/settings.json` 中配置：

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

详细按键说明见 [`xz-pi-vim/README.md`](./xz-pi-vim/README.md)。

## 查看版本

### 查看 npm 最新版本

```bash
npm view xz-pi-playwright-cli version
npm view xz-pi-websearch version
npm view xz-pi-vim version
```

### 查看用户级已安装版本

```bash
npm list --prefix "$HOME/.pi/agent/npm" xz-pi-playwright-cli --depth=0
npm list --prefix "$HOME/.pi/agent/npm" xz-pi-websearch --depth=0
npm list --prefix "$HOME/.pi/agent/npm" xz-pi-vim --depth=0
```

### 查看项目级已安装版本

在项目根目录执行：

```bash
npm list --prefix .pi/npm xz-pi-vim --depth=0
```

## 更新

更新单个未固定版本的包：

```bash
pi update npm:xz-pi-vim
```

更新所有已安装的 Pi 包：

```bash
pi update --extensions
```

将固定版本切换到另一个版本：

```bash
pi install npm:xz-pi-vim@0.2.0
```

## 卸载

用户级卸载：

```bash
pi remove npm:xz-pi-vim
pi remove npm:xz-pi-websearch
pi remove npm:xz-pi-playwright-cli
```

项目级卸载：

```bash
pi remove -l npm:xz-pi-vim
```

## 本地开发

克隆并安装工作区依赖：

```bash
git clone https://github.com/Xuzan9396/xz-pi.git
cd xz-pi
npm install
```

运行全部类型检查、测试和 npm 打包检查：

```bash
npm run check
```

临时加载尚未发布的本地包：

```bash
pi -e ./xz-pi-vim
pi -e ./xz-pi-websearch
pi -e ./xz-pi-playwright-cli
```

本地源码修改后，可在 Pi 中执行 `/reload`。

## 版本管理与自动发布

三个子包采用独立的 [Semantic Versioning](https://semver.org/) 和 [Changesets](https://github.com/changesets/changesets)：

- `patch`：兼容性问题修复，例如 `0.1.0 → 0.1.1`
- `minor`：向后兼容的新功能，例如 `0.1.0 → 0.2.0`
- `major`：不兼容变更，例如 `0.1.0 → 1.0.0`

修改可发布子包后执行：

```bash
npm run changeset
```

然后：

1. 选择发生变化的子包
2. 选择 `patch`、`minor` 或 `major`
3. 填写变更摘要
4. 提交源码和生成的 `.changeset/*.md`
5. 推送或合并到 `main`
6. GitHub Actions 自动创建或更新 **chore: release packages** PR
7. 合并发布 PR 后，仅发布版本发生变化的子包

CI/CD 配置：

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)：执行类型检查、测试及 npm 打包校验
- [`.github/workflows/release.yml`](./.github/workflows/release.yml)：维护 Changesets 发布 PR 并发布 npm 包

仓库需要配置名为 `NPM_TOKEN` 的 GitHub Actions Repository Secret。该 Token 必须具有三个 npm 包的发布权限，且不得写入源码、日志或提交记录。

## 常见问题

### 安装了包但没有生效

执行 `/reload` 或重启 Pi，并通过 `pi list` 确认包已经登记。项目级包还需要信任当前项目。

### 为什么 `pi list` 没显示具体版本？

`pi list` 主要展示包来源和安装位置。请使用[查看版本](#查看版本)中的 `npm list --prefix ...` 命令读取实际安装版本。

### 为什么更新后版本没变化？

如果安装源包含 `@版本号`，该包处于固定版本状态。请重新执行 `pi install npm:包名@新版本`。

### Web Search 工具发生重名冲突

不要同时启用 `xz-pi-websearch` 与其他注册 `web_search`、`fetch_content` 的扩展，例如 `pi-web-access`。

## License

各子包使用自己的许可证，详情请查看对应目录中的 `LICENSE` 和 `README.md`。
