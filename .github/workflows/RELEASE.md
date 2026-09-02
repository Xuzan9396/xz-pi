# 单包独立发版指南

本仓库是 npm Workspaces Monorepo，使用 Changesets 管理相互独立的包：

- `xz-pi-btw`
- `xz-pi-playwright-cli`
- `xz-pi-websearch`
- `xz-pi-vim`

现有配置已经支持**只升级并发布发生变化的包**，不需要修改 `ci.yml` 或 `release.yml`。

## 核心机制

`.changeset/config.json` 中没有配置 `fixed` 或 `linked` 包组，因此各包版本互不绑定：

```json
{
  "fixed": [],
  "linked": []
}
```

一次变更只要在 Changeset 中选择一个包，Release PR 就只会更新该包的版本；Release PR 合并后，`changeset publish` 也只会发布该包。

> CI 仍会检查所有 workspace。这是有意保留的全仓回归保护，不代表所有包都会发版。

## 标准流程

以下以只修改并发布 `xz-pi-websearch` 为例。

### 1. 修改并验证目标包

```bash
# 修改 xz-pi-websearch 下的源码
npm run check --workspace=xz-pi-websearch

# 提交前建议再运行全仓检查
npm run check
```

### 2. 创建 Changeset

推荐在仓库根目录使用中文发布助手：

```bash
./tag.sh
# 或 npm run tag
```

脚本会：

1. 从 npm 获取各包当前版本和发布提交 `gitHead`。
2. 将对应包目录与发布提交对比，自动跳过没有变化的包；npm 尚不存在的新包视为有变化。
3. 使用 `↑/↓` 移动、`Space` 多选、`Enter` 确认，可一次选择多个包。
4. 为每个包显示中文版本选项及结果：
   - 补丁版本：兼容性修复，例如 `0.1.0 -> 0.1.1`
   - 次版本：向后兼容的新功能，例如 `0.1.0 -> 0.2.0`
   - 主版本：不兼容变更，例如 `0.1.0 -> 1.0.0`
5. 发现已有 Changeset 时展示其预计版本；重新选择该包会替换旧版本级别，避免旧 `major` 覆盖新的 `patch`。
6. 生成一个包含多个包的 Changeset，并可选择运行检查、提交和推送。

仍可使用 Changesets 原始英文界面：

```bash
npm run changeset
```

手动操作时选择目标包、`patch` / `minor` / `major`，再填写面向用户的变更摘要。

命令会生成类似下面的文件：

```text
.changeset/friendly-tools-search.md
```

示例内容：

```markdown
---
"xz-pi-websearch": patch
---

修复 GitHub 页面内容提取失败的问题。
```

确认文件中只出现目标包。不要手动修改其他包的 `version`。

### 3. 提交业务代码和 Changeset

```bash
git add xz-pi-websearch .changeset

git commit -m "fix(websearch): improve GitHub content fetching"
git push
```

创建 Pull Request。`.github/workflows/ci.yml` 会执行全仓安装、测试、类型检查和 npm 打包检查。

### 4. 合并业务 Pull Request

业务 PR 合并到 `main` 后，`.github/workflows/release.yml` 中的 `changesets/action` 会创建或更新以下 Release PR：

```text
chore: release packages
```

由于 Changeset 只选择了 `xz-pi-websearch`，Release PR 应只包含该包相关的版本更新，例如：

- `xz-pi-websearch/package.json` 的 `version`
- `xz-pi-websearch/CHANGELOG.md`
- 根 `package-lock.json` 中对应 workspace 的版本信息
- 删除已消费的 `.changeset/*.md`

`xz-pi-vim` 和 `xz-pi-playwright-cli` 的版本不应变化。

### 5. 检查并合并 Release PR

合并前确认：

- Release PR 只提升预期包的版本。
- 版本级别符合预期。
- Changelog 内容正确。
- CI 检查通过。

Release PR 合并到 `main` 后，Release Action 再次运行：

```bash
npm run release
# 实际执行 changeset publish
```

Changesets 会比较本地包版本和 npm Registry 已发布版本，只发布版本发生变化且尚未发布的包。因此本例只会发布 `xz-pi-websearch`。

## 如何确认只发布了目标包

Action 日志中应只出现目标包的发布记录。也可以查询 npm：

```bash
npm view xz-pi-websearch version
npm view xz-pi-vim version
npm view xz-pi-playwright-cli version
```

目标包应升级到新版本，其他两个包应保持原版本。

## 自动化触发规则

当前两个 Workflow 的触发规则如下：

1. 向 `main` 推送任何提交：同时触发 `CI` 和 `Release`。
2. 普通业务提交包含 `.changeset/*.md` 时：`Release` 创建或更新 `changeset-release/main` 分支上的 `chore: release packages` PR，此时不会发布 npm。
3. Release PR 会触发 `pull_request` 类型的 `CI`。
4. 合并 Release PR：再次产生一次 `main` push，`Release` 执行 `npm run release`，自动将尚未发布的新版本发布到 npm。

因此 npm 发布本身是自动的，但默认保留“人工检查并合并 Release PR”这道版本确认闸门。

### 为什么 Release PR 的 CI 可能要求手动批准

Release PR 由 `github-actions[bot]` 创建。若仓库的 Actions 策略要求首次贡献者工作流获得批准，Bot 第一次创建 PR 时会显示 `Action required`。这是 GitHub 的工作流安全审批，不是 npm 发布失败。

可在以下位置调整：

```text
Repository Settings → Actions → General
→ Approval for running fork pull request workflows from contributors
```

建议使用“只审批 GitHub 新用户”的策略，而不是关闭所有安全限制。第一次批准并合并 Bot 的 PR 后，在“首次贡献者”策略下通常也不会重复要求批准。

## GitHub 仓库要求

Release Workflow 依赖以下配置：

1. Repository Secret `NPM_TOKEN` 已设置。
2. Token 对目标 npm 包具有发布权限。
3. GitHub Actions 具有创建 Pull Request 和写入仓库内容的权限。
4. 若 npm 包启用了 Trusted Publishing，应确保 npm 侧配置与本仓库及 `release.yml` 一致。

不要把 npm Token 写入源码、Changeset、工作流日志或提交记录。

## 常见情况

### 同时修改多个包，但只需发布一个包

Changeset 中只选择需要面向用户发版的包。未选择的包不会仅因源码发生变化而自动升级或发布。

但如果其他包的修改也会影响用户，应该分别为它们添加版本变更，避免源码已变化而发布版本仍未更新。

### 一个包有多项变更

可以为每项改动分别创建 Changeset。Changesets 会在 Release PR 中合并这些记录，并根据最高级别确定最终版本升级幅度。

### Changeset 误选了其他包

在业务 PR 合并前，直接修改或重新生成 `.changeset/*.md`，确保 frontmatter 中只保留目标包。

### Release PR 更新了多个包

通常表示 `main` 上还存在其他尚未发布的 Changeset。Release PR 会集中处理所有待发布变更。检查 `.changeset/` 和 Release PR 内容，不要在未确认时直接合并。

### CI 为什么检查所有包

根目录脚本为：

```json
"check": "npm run check --workspaces --if-present && npm pack --dry-run --workspaces"
```

它会检查所有 workspace，以发现跨包或共享依赖引起的回归。全仓检查和单包发布是两套独立机制：

- CI 检查范围：全部包
- Changeset 版本范围：被选择的包
- npm 发布范围：版本已变化且尚未发布的包

## 最短操作清单

```bash
# 1. 修改并检查目标包
npm run check --workspace=xz-pi-websearch

# 2. 只为目标包创建版本记录
npm run changeset

# 3. 提交业务代码和 .changeset 文件
git add xz-pi-websearch .changeset
git commit -m "fix(websearch): describe the change"
git push

# 4. 合并业务 PR
# 5. 检查并合并 chore: release packages PR
# 6. 在 Release Action 和 npm Registry 确认发布结果
```
