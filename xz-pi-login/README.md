# xz-pi-login

为 [Pi](https://pi.dev) 提供可命名的多供应商登录。每个 `auth.json` Provider 都是独立、可直接选择的账号；用户通过原生 `/model` 或 `/pmodel` 手动选择供应商和模型，不注册内部逻辑 Provider，也不自动切换账号。

本包基于 `pi-rotator` 重构。账号不再使用 `-account-N`，而是由你输入有意义的别名：

```text
openai-work
openai-personal
anthropic-team
```

## 环境要求

- Node.js 22.19+
- Pi 1.1+（使用宿主的 Native Provider API，不兼容旧版 Pi）

## 安装

```bash
pi install npm:xz-pi-login
```

本地开发：

```bash
pi -e ./xz-pi-login
```

## 添加账号

输入：

```text
/xz-login add
```

Pi 会补全当前可用的 Provider。列表来自 Pi 内置 Provider、运行时 Native Provider Registry 和显式公布的账号工厂，不是本包维护的静态名单。

扩展通过 TypeScript 入口静态导入宿主 Pi 的 Provider 工厂，在启动模型选择和 scoped 范围生成之前注册账号。它不会加载仓库旧版 `pi-ai` 作为备用，也不依赖 `session_start` 才补上 OAuth。已有的 `openai-xuzan` 等账号可直接出现在 `/model`、`/scoped-models` 和 `/pmodel` 中；`/pmodel` 的 scoped 页面仍只显示已选范围内的模型。

原生 Provider 的每个别名都独立提供模型目录，不再只展示同一家族的一个账号。例如 `openai-codex-work` 和 `openai-codex-xuzan` 都已登录时，两者都会出现在 `/pmodel` 的 all 页面及宿主可用模型目录中；手动切换账号不会隐藏其中一个。未登录别名仍可在 `/login` 中登录，但是否出现在可用模型列表由 Pi 的认证检查决定。

新建原生账号登录成功后，Pi 会同步认证可用状态；打开 `/pmodel` 还会刷新目录，不需要先发一条任务或执行 `/xz-login refresh`。升级后执行 `/reload` 即可恢复以前被隐藏的已登录账号，无需删除或重新创建登录。scoped 页面仍只显示已选范围，新增账号可在 all 页面勾选后按 Ctrl+S 保存。

选择 Provider 后会提示输入别名。输入 `work` 后，本包准备 `openai-work`，并在 TUI 输入框预填：

```text
/login openai-work
```

也可以直接执行：

```text
/xz-login add openai work
```

裸 `/login` 会先询问认证方式，别名 Provider 会显示在下一层列表中，例如 `OpenAI (work)`。也可以跳过查找，直接执行：

```text
/login openai-work
```

同一 Provider 同时支持 OAuth 和 API key 时，Pi 会继续让你选择该账号的认证方式。

别名会转为小写，并且必须匹配：

```text
[a-z0-9][a-z0-9_-]{0,31}
```

Provider ID、登录、已准备账号或别名映射已经存在时，不会覆盖原数据。

## 恢复手动添加的已有登录

Pi 的 `auth.json` 保存凭据，`config/xz-pi-login/accounts.json` 保存基础 Provider/别名映射，`/login` 展示已注册的 Provider。仅手动添加凭据不会自动创建映射或注册别名，所以可能出现 `already exists (a login already exists)`，但 `/login` 中找不到账号。

保留现有凭据、明确补回映射：

```text
/xz-login restore openai-codex work
```

确认提示后恢复 `openai-codex-work`。无 UI 时需要显式确认：

```text
/xz-login restore openai-codex work confirm
```

`restore` 只添加缺失的映射和注册 Native Provider，不修改、删除或复制凭据，不切换当前模型。基础 Provider 和别名必须由你明确选择，程序不会从账号名自动猜测，也不会自动迁移旧路由器的账号。已有映射、其他包已注册的 Provider、缺失凭据或不匹配的认证类型会拒绝恢复。`models.json` 中仅有 `modelOverrides`（及可选显示名称）、没有模型、独立 endpoint 或认证配置的占位 Provider 可以明确恢复，原元数据会保留；带自定义 endpoint、模型列表或认证配置的 Provider 不会被接管。恢复成功后 `/login` 会显示对应账号；是否登录仍取决于现有凭据的有效性。

Provider 注册失败会撤回本次新建的映射，保留登录；仅目录刷新失败时会保留已恢复的映射并提示 `/reload`。

## 删除账号

```text
/xz-login remove
```

TUI 会列出由本包管理的账号，选择后要求二次确认。也可以使用补全或完整命令：

```text
/xz-login remove openai-work
/xz-login remove openai-work confirm
```

删除使用可续办的逐文件流程：先确认目标，再删除该账号凭据、`~/.pi/agent/models.json` 中完全同名的 Provider、精确设置/展示引用和别名注册。基础 Provider 与兄弟账号不会删除；并发改变过的目标 Provider 会保留并报告。当前窗口正在请求时暂缓；空闲且当前直接选择该账号时，先切到同供应商、同模型的逻辑池，不要求手动换账号。凭据已删除但后续清理失败时，重试同一命令会向前完成，不恢复 token。

## 常用命令

```text
/xz-login                 打开菜单；无 UI 时显示状态
/xz-login add             选择 Provider 并输入别名
/xz-login add P A         准备 P-A
/xz-login restore P A     确认后补回已有登录的缺失映射
/xz-login status          显示家族、账号、冷热和冷却状态
/xz-login refresh         重新读取登录和别名映射
/xz-login accounts        显示账号额度（Provider 支持时）
/xz-login limits          显示当前账号额度
/xz-login remove          选择并删除本包管理的账号
/xz-login reset           清除本地冷却和请求计数
```

## 模型选择与会话状态

本包不提供独立的账号切换命令。请使用 Pi 原生 `/model` 或 `/pmodel` 选择 `auth.json` 中实际登录的 Provider；`/xz-login next` 仍保持移除。

普通新会话优先使用可信项目默认，项目未设置时继承全局默认。CLI 显式选模、恢复/分叉会话和当前窗口主动选择仍由 Pi 保留。账号不会自动接替；Provider 或模型删除后会清理精确配置引用并提示用户手动选择。

仅明确的额度耗尽或鉴权失败、且本轮尚无文本输出或工具副作用时，池才会在**同一基础 Provider、同一模型 ID、兼容 API/能力**内接替一次。超时、取消、普通 403、能力错误、部分输出及工具调用不会自动重放；全部账号不可用时请求明确失败，所选模型和全局默认保持不变。OpenAI 与 OpenAI Codex 是不同基础 Provider，不混池。

思考度由 Pi 原生 `/thinking` 管理：

- 当前会话保留用户操作后的状态，不因对话结束被本扩展覆盖。
- 新窗口使用 Pi 的模型级默认或全局默认思考度，不沿用其他窗口的临时选择。
- 恢复旧会话时由 Pi 读取该会话最后记录的模型和思考度，不由本扩展补切。
- 历史模型已下架或账号无认证时，沿用 Pi 的恢复失败提示与默认回退。

如果旧版本已经把自动切换写进历史，Pi 会恢复那份实际记录；需要通过 `/model`、`/pmodel` 和 `/thinking` 手动纠正一次。本包不迁移或改写历史记录。升级后执行 `/reload` 或重启，让当前窗口加载新的扩展。

## 配置和观察状态

配置文件：

```text
~/.pi/agent/config/xz-pi-login/config.json
```

示例：

```json
{
  "ttlMs": 300000,
  "ttlByFamily": {
    "openai": 300000
  },
  "cooldownMs": 21600000,
  "debugLog": true,
  "enabled": true,
  "showUsage": true
}
```

旧 `strategy`（包括 `balanced`、`failover`、`round-robin`）和 `announceSwitches` 仍只读忽略，不能重新开启随机轮转或自动接替；`ttlMs`、`ttlByFamily` 和 `cooldownMs` 仅保留给现有诊断与兼容状态。

账号归属保存在：

```text
~/.pi/agent/config/xz-pi-login/accounts.json
```

该文件只保存 Provider ID、基础 Provider 和别名，不保存 token、API key 或 OAuth 凭据。凭据始终由 Pi 的 `/login` 管理。

旧 `config/xz-pi-login/pools.json` 只作为 `xz-login-*` 配置迁回物理 Provider 的兼容来源，并继续承载已开始的删除进度；不再参与请求路由，也不保存凭据。旧逻辑默认与精确 scoped 引用会迁回记录的首选物理账号，首选不可用时按 `auth.json` 顺序选择同基础 Provider、同模型账号。

## 独立模式

`xz-pi-login` 仅支持新的显式别名模式：

- 不自动识别 `openai-account-2`
- 不迁移 `pi-rotator` 或 `pi-multi-account` 状态
- 不提供 cutover
- 不应与其他账号路由器同时启用

检测到 `pi-rotator`、`pi-multi-account`、`pi-failover` 等路由器时，本包仍进入 standby，避免账号 Provider 注册和凭据归属冲突。这些外部路由器自身的自动切换不受本包控制。

## 日志

```text
~/.pi/agent/xz-pi-login-debug.log
~/.pi/agent/xz-pi-login-journal.jsonl
```

日志只记录受控元数据、哈希和账号观察结果，不记录请求正文或凭据，也不会驱动模型选择。

## 开发

```bash
npm test --workspace xz-pi-login
npm run check --workspace xz-pi-login
npm pack --dry-run --workspace xz-pi-login
```

测试包含真实宿主加载器的离线启动、双 Codex 账号同时展示、reload、登录/退出可用状态、独立凭据解析、会话重建及 `/pmodel` Tab all / 保存同步回归检查，并主动放置旧版 workspace SDK 来确认它不会被加载。不使用真实登录凭据，也不修改个人配置。

如果是本地 monorepo，旧版 Pi 开发依赖可能来自其他 workspace 的固定版本。不要手动删除 `node_modules/@earendil-works/*`，也不要删除 `auth.json`。更新相关 workspace 的依赖声明后用 npm 重新安装；只处理本包可运行：

```bash
npm install --ignore-scripts --workspace xz-pi-login
```

全局 Pi 低于 1.1 时，先更新 Pi，再重新启动或 `/reload`。全局 Pi 已经是 1.1+ 时无需卸载。

上游来源与许可证见 [`UPSTREAM.md`](./UPSTREAM.md)、[`LICENSE`](./LICENSE) 及 `lib/cursor/` 下的 License、NOTICE 和 PROVENANCE 文件。
