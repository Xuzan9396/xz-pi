# 全自动 npm 发版指南

本仓库是 npm Workspaces Monorepo，使用 Changesets 独立管理以下包的版本：

- `xz-pi-btw`
- `xz-pi-playwright-cli`
- `xz-pi-websearch`
- `xz-pi-vim`

`.changeset/config.json` 中 `fixed` 和 `linked` 均为空，因此 Changeset 选择哪个包，就只升级并发布哪个包。

## 标准流程

在 `main` 分支完成代码修改后，从仓库根目录执行：

```bash
./tag.sh
# 或
npm run tag
```

脚本会：

1. 查询各包当前 npm 版本，并检测相对已发布版本的代码变化。
2. 选择要发布的包和 `patch`、`minor`、`major` 升级类型。
3. 生成或更新 `.changeset/*.md`。
4. 按选择执行全仓检查。
5. 经确认后提交全部修改并推送 `main`。
6. 等待 GitHub Release Action 自动发布。
7. 在终端展示 npm Registry 中确认后的实际新版本。
8. 拉取 Action 自动生成的版本提交，使本地 `main` 与远程同步。

整个流程不再创建 Release PR，也不需要到 GitHub 手动合并发布提交。

## GitHub Release Action

`.github/workflows/release.yml` 在 `main` 收到推送后自动执行：

1. 安装依赖并运行 `npm run check`。
2. 发现待处理 Changeset 时运行 `changeset version`。
3. 更新 `package-lock.json`。
4. 将版本号、Changelog 和已消费 Changeset 的变更提交到 `main`。
5. 运行 `changeset publish`，只发布版本高于 npm Registry 的包。
6. 将 npm 发布产生的 Git Tag 推送到 GitHub。

Workflow 也支持在 GitHub 上手动重新运行。即使版本提交已经成功、npm 发布暂时失败，再次运行也会尝试发布尚未存在于 npm Registry 的版本。

## 版本示例

Changeset：

```markdown
---
"xz-pi-vim": minor
---

增加工具引用和斜杠自动补全。
```

如果当前版本是 `0.1.0`，Action 会自动发布：

```text
xz-pi-vim@0.2.0
```

成功后 `tag.sh` 会在终端显示类似：

```text
=== npm 发布完成 ===
  xz-pi-vim@0.2.0
```

## 必要配置

仓库必须满足：

1. GitHub Secret `NPM_TOKEN` 已配置，并有目标 npm 包的发布权限。
2. GitHub Actions 的 Workflow permissions 允许写入仓库内容。
3. `main` 分支保护规则允许 GitHub Actions Bot 推送版本提交；若不允许，需要为该 Bot 配置对应 bypass 权限。
4. 如果 npm 使用 Trusted Publishing，npm 侧仓库及 Workflow 配置必须与 `.github/workflows/release.yml` 一致。

不要将 npm Token 写入源码、Changeset、日志或提交记录。

## 常见问题

### 为什么只能从 main 运行 `tag.sh` 的自动推送？

Release Action 只监听 `main`。脚本会阻止从其他分支进入自动发布等待，避免推送后一直等待超时。

### 发布等待超时怎么办？

打开 GitHub Actions 的 `Release` 日志查看失败步骤。修复配置后可手动重新运行 Workflow；也可以再次推送 `main`。不要重复提高包版本。

### 为什么仍保留 CI 的 pull_request 触发？

移除的是 Changesets 的 **Release PR**。普通业务 PR 的 CI 检查仍保留，不会触发 npm 发布，也不要求发布流程必须使用 PR。

### 同时修改多个包但只发布一个包

在 `tag.sh` 中只选择需要发版的包。全仓检查仍会覆盖所有 workspace，但 npm 只发布 Changeset 中升级的包。
