# Changesets

修改需要发布的包后，推荐在仓库根目录运行中文多包发布助手：

```bash
./tag.sh
# 或 npm run tag
```

脚本会自动跳过没有变化的包，支持 `Space` 多选、`Enter` 确认，并显示当前版本、中文升级类型和目标版本。

也可以运行 Changesets 原始英文命令：

```bash
npm run changeset
```

提交生成的 Markdown 文件。变更进入 `main` 后，Release Workflow 会维护发布 PR；合并发布 PR 后，只发布版本发生变化且 npm 尚未存在该版本的包。
