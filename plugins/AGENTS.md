# CoClaw 插件层开发约定

> 适用范围：`coclaw/plugins` 及其所有子目录。
> 本文件是相对 `coclaw/AGENTS.md` 的增量规则；具体插件可在各自目录再补充更细规则。

## 当前状态

- 当前仅有一个插件工作区：`plugins/openclaw`。
- 目录保留 `plugins/*` 形态，用于未来扩展到其他 Agent 插件。

## 核心原则（插件层）

- 插件运行在 OpenClaw gateway 进程内，**稳定性优先于功能速度**。
- 任何改动都应以“不能影响 gateway 可用性”为第一目标。
- 先最小可用，再逐步扩展，避免一次性大改。

## 插件清单与一致性

1. `openclaw.plugin.json` 中的 `id` 必须与代码导出的 `plugin.id` 一致。
2. `openclaw.plugin.json` 必须提供 `configSchema`（即使为空对象 schema）。
3. `plugins.entries` 的 key 必须使用真实 plugin id，禁止使用猜测或包名变体。

## 命名与 ID 体系

- **npm 包名**：`@coclaw/openclaw-coclaw`（scoped，发布到 npm）。
- **Plugin ID**：`openclaw-coclaw`，用于 `plugins.entries` / `plugins.installs`、`openclaw.plugin.json` 的 `id`。与 npm 包名去 scope 后一致，避免 idHint mismatch 警告。
- **Channel ID**：`coclaw`，用于 channel 注册、消息路由、state 子目录。
- **Command 名**：`coclaw`，用于 CLI（`openclaw coclaw bind`）和 IM 命令（`/coclaw bind`）。
- 修改插件命名策略时，必须同步检查：
  - `openclaw.plugin.json`（id）
  - `package.json`（name）
  - `~/.openclaw/openclaw.json`（plugins.entries / plugins.load.paths）
- 变更后必须执行：
  - `openclaw plugins doctor`
  - `openclaw plugins list`
  - `openclaw gateway status`

## 配置存储原则

- 插件的绑定信息（token、clawId 等运行时状态）**不存储在 `openclaw.json` 中**，而是存储在 OpenClaw state 目录下的插件自有文件中（如 `~/.openclaw/coclaw/bindings.json`）。
- 这是为了避免卸载插件后 `channels.<id>` 节点残留导致 OpenClaw gateway schema 验证失败、无法启动。
- `openclaw.json` 中只保留 OpenClaw 管理的插件元数据（`plugins.entries`、`plugins.installs`），这些由 `openclaw plugins install/uninstall` 自动维护。
- `openclaw.plugin.json` 的 `configSchema` 仅用于 `plugins.entries.<id>.config`（如 serverUrl、gatewayWsUrl 等插件级配置），不用于绑定状态。

## 安装替换流程坑位（2026-02-28）

- 不要先手动删除 `~/.openclaw/extensions/<plugin-id>` 再安装；若此时 `openclaw.json` 仍引用该 path，会导致 gateway 配置无效并启动告警/失败。
- 正确顺序：
  1. 直接执行 `openclaw plugins install <path>`（让 OpenClaw 统一改写配置）
  2. 再执行 `openclaw gateway restart`
  3. 最后检查 `openclaw gateway status` + `openclaw plugins doctor`
- 若必须手动删除目录，先同步移除 `plugins.load.paths` 与对应 `plugins.entries`，再重启 gateway。
## 稳定性与异常处理

- 所有 `registerGatewayMethod` handler 必须 `try/catch`，错误响应须遵循 OpenClaw gateway 协议：
  - 异常：`respond(false, undefined, { code, message })`
  - 参数校验失败：同上格式
  - **禁止**使用旧格式 `respond(false, { error })`（error 放在 payload 中会导致下游无法解析）。
- **禁止**在插件中注册全局异常兜底（如 `process.on('uncaughtException'/'unhandledRejection')`），以免污染 gateway 全局异常语义。

## 测试与接入门禁

- 进入 gateway 前，必须先通过插件自身 `pnpm check` + `pnpm test`。
- 高风险插件建议（当前 `plugins/openclaw` 已执行）达到 100% coverage 门禁后再接入。
- 接入顺序建议：
  1. 离线/mocks 验证
  2. 只读链路验证
  3. 写路径验证

## 文档同步

插件关键决策/踩坑/修复必须同步到：
- 对应插件目录 `STATUS.md`
- `coclaw/docs` 下相关决策文档
