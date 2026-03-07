# OpenClaw Plugin STATUS

## 当前状态（2026-03-05）

- 插件工作区：`plugins/openclaw`，已稳定运行。
- 对外标识：
  - npm 包名：`@coclaw/openclaw-coclaw`；plugin id：`coclaw`
  - channel：`coclaw`
  - CLI 子命令：`coclaw`（`openclaw coclaw bind/unbind`）
- 单一入口 `index.js` 同时注册：
  - channel（coclaw）
  - service（`coclaw-realtime-bridge`，通过 `registerService` 注册，仅在 gateway daemon 启动时运行）
  - command（`/coclaw bind/unbind`）
  - gateway methods（`coclaw.refreshBridge` / `coclaw.stopBridge` / `nativeui.sessions.listAll` / `nativeui.sessions.get`）
  - CLI（`openclaw coclaw bind/unbind`）
- 绑定信息存储在 `~/.openclaw/coclaw/bindings.json`（独立于 `openclaw.json`）。
- 测试门禁：`pnpm verify` 通过，覆盖率 100%。

## 关键里程碑

### 绑定信息存储迁移（2026-03-04）
- 从 `openclaw.json` 的 `channels.coclaw.accounts.default` 迁移到独立文件 `~/.openclaw/coclaw/bindings.json`。
- 决策理由：避免卸载插件后残留 `channels.coclaw` 导致 gateway schema 验证失败。
- 首次读取自动从旧位置迁移（`openclaw.json` channels / `.coclaw-tunnel.json`）。

### registerCli 双注册（2026-03-04）
- 新增 `src/cli-registrar.js`，通过 OpenClaw `registerCli` API 注册 `openclaw coclaw bind/unbind`。
- bind/unbind 成功后通过 gateway RPC 通知插件刷新/停止 bridge（见下）。

### CLI 通知改为 Gateway RPC & bridge 生命周期优化（2026-03-05）
- **问题 1**：`openclaw plugins install/uninstall` 进程不退出——因 `register()` 中直接启动 realtime bridge 创建了 WebSocket 连接。
- **修复**：将 `startRealtimeBridge` 改为通过 `api.registerService()` 注册，bridge 仅在 gateway daemon 启动时运行，CLI 上下文不启动。
- **问题 2**：bind/unbind 后 `openclaw gateway restart` 重启整个 gateway，耗时 ~20 秒。
- **修复**：注册 `coclaw.refreshBridge` / `coclaw.stopBridge` gateway methods，CLI 改为 `openclaw gateway call` 发送轻量 RPC 通知，耗时 <1 秒。
- **问题 3**：`openclaw gateway call` 完成 RPC 后进程不退出（WebSocket handle 未清理），`execSync` 10 秒超时 100% 误报失败。
- **修复**：将 `execSync` 替换为 `spawn`（异步），通过解析 stdout JSON 判断成功，检测到输出后延迟 2s kill 子进程。核心逻辑提取至 `src/common/gateway-notify.js`。
- 详见 `docs/cli-gateway-restart.md`。

### session-manager 增强（2026-03-01 ~ 2026-03-03）
- `listAll` 支持 reset 归档识别、deleted 排除、sessionId 去重。
- `listAll` 新增 `derivedTitle`（从首条 user message 生成截断标题）。
- `get` 优先读取 reset 归档。

### realtime bridge 重连策略加固（2026-02-28）
- 重连间隔 10s，连接建立超时 10s，error 事件主动重连。

### ensureMainSessionKey 禁用（2026-03-03）
- 发现 bug：每次 WebSocket 重连误触 `sessions.reset`。
- 功能已禁用，待修复。详见 `docs/ensure-main-session-bug-analysis.md`。

### 命名定稿 & npm 发布（2026-03-07）
- npm 包名：`@coclaw/openclaw-coclaw`（scoped to `@coclaw`）。
- plugin id：`coclaw`（`openclaw.plugin.json` 中的 `id`，优先于从包名派生的 `idHint`）。
- 以源码形式发布。

### bot 命名策略（2026-02-28）
- 绑定阶段不提交 `name`，server 通过 gateway WebSocket 获取实例名，未设置时前端回退显示 `OpenClaw`。

## 风险控制提醒

- 插件运行在 gateway 进程内，接入前必须先完成离线验证与全量单测。
- `pnpm verify` 未通过时，禁止安装到 OpenClaw gateway。
