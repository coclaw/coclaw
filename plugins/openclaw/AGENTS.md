# CoClaw OpenClaw 插件开发约定

> 适用范围：`coclaw/plugins/openclaw` 及其子目录。
> 本文件是相对 `coclaw/CLAUDE.md` 的增量。仅写**硬约束**和**topic→doc 索引**——
> 详细背景、设计决策、机制原理一律下沉到 `docs/`，按需阅读。

## 起点

不熟悉本插件时**先读 [`docs/architecture.md`](docs/architecture.md)**——一份地图：模块→职责映射、通信拓扑、状态文件清单。

## 硬约束（写代码前必读）

### 绑定/设置存储

- 绑定信息存 `<state-dir>/coclaw/bindings.json`（structure: `{ default: { serverUrl, clawId, token, boundAt } }`）；插件设置存同目录 `settings.json`（含 claw name 等）。`<state-dir>` 由 OpenClaw 决定（默认 `~/.openclaw`，但用户可通过环境变量、CLI flag、profile 覆盖到任意位置）。
- **禁止**写入 `openclaw.json` 的 `channels.coclaw` 或 `plugins.entries.*.config`。**Why:** 卸载插件后这些节点残留会让 OpenClaw schema 验证失败、gateway 起不来。
- `config.js` / `settings.js` 是这两个文件的**唯一读写入口**。其它模块直接动文件 = bug。
- env `COCLAW_SERVER_URL` 可运行时覆盖 serverUrl，不影响存储。

### State / sessions 路径解析

- `src/claw-paths.js` 是路径解析的**唯一入口**。所有 `state-dir` / sessions 相关路径计算必须经它。
- **禁止**手拼 `os.homedir() + '.openclaw'` 或 `~/.openclaw`。**Why:** OpenClaw 推荐用户级安装但允许自定义 state-dir（系统级安装、多 profile、容器、`OPENCLAW_STATE_DIR`），手拼必然在非默认部署下错位。
- `resolveStateDir` 一类**有 runtime 等价 API** 的能力走 **runtime 注入**（`rt.state.resolveStateDir()`），不直接 import `openclaw/plugin-sdk/state-paths`。**Why:** runtime API 自 2026-02-19 公开，比 SDK 子路径（2026-03-16）早一个月，对老 gateway 更兼容。
- **runtime 没有等价 API 时**（如 `openclaw/plugin-sdk/provider-auth` 上游确实没暴露 `rt.providerAuth.*`），允许（并必须）import plugin-sdk 子路径，但严格遵循"字面量 specifier + 出现在插件入口源码里"的硬约束——详见 [`docs/openclaw-research/plugin-sdk-and-runtime.md`](../../docs/openclaw-research/plugin-sdk-and-runtime.md) 的"第三方插件如何 import Plugin SDK"章节。**Why:** OpenClaw plugin loader 只对入口文件源码做正则扫描决定是否走 jiti alias；变量 / 子模块字面量都不命中，回退到原生 Node 解析必败（部署目录不带 `openclaw` 包）。**注**：上游正式契约建议 `package.json` 声明 `openclaw` 为 optional peerDependency；本仓库出于 pnpm v10 monorepo lock bloat 已移除此声明，loader alias 不依赖本地 `openclaw` 包即可工作，详见 `.changeset/drop-openclaw-peer-dep.md`。
- **禁止**在 gateway 主进程读 `OPENCLAW_STATE_DIR` 环境变量来推 state-dir。**Why:** runtime 注入的 `resolveStateDir` 内部已经处理了 env / profile / CLI flag 全部组合，外面再读会产生分叉来源。
- 例外：`auto-upgrade/state.js` 因被 worker 子进程共用（worker 没 runtime），保留独立的 env 兜底——不要"统一"它。
- 读 OpenClaw 自家 sessions 数据（sessions.json / 单条 transcript JSONL）必须走 `claw-paths.js` 的 `sessionStorePath` / `sessionTranscriptPath`。**Why:** state-dir 不一定是 `~/.openclaw`，手拼必然在系统级安装/多 profile/容器场景下错位。
- 当前 `claw-paths.js` 调上游 helper 时不传 `store` 配置和 sessions-index `entry`，目标永远是 OpenClaw 默认的 `<state-dir>/agents/<agentId>/sessions/...` 布局；honoring `agents.<id>.store` / `entry.sessionFile` 覆盖是 follow-up（见 `TODO.md`）。

### 文件 I/O 安全

- **禁止裸 `fs.writeFile`**——写自管文件必走 `atomicWriteFile` / `atomicWriteJsonFile`（`src/utils/atomic-write.js`）。**Why:** 写一半崩溃会留半截文件。
- read-modify-write **必须加锁**——同一文件的读→改→写在同一个 `mutex.withLock()` 内（`src/utils/mutex.js`，每文件独立 mutex 实例）。
- 纯只读可不加锁（最多读到略旧快照）。
- `withLock(...)` 返回的 Promise 若不 await，**必须 `.catch()`**——unhandled rejection 会带垮 gateway。
- **禁止嵌套同把锁**（`withLock(fn)` 内再调同一 mutex 的 `withLock` 死锁）。
- fn 应尽量短，长持锁阻后续。

### Logger / remoteLog

- gateway 注入的 logger 是 pino 风格：只有 `.info() / .warn() / .error()`，**没有 `.log()`**。
- 调用一律用可选链：`logger.info?.(...)` / `logger.warn?.(...)` / `logger.error?.(...)`。**Why:** logger 缺方法或本身为 undefined 时不抛异常中断流程。
- **禁止** `logger('msg')`（不是函数）/ `logger.log(...)`（不存在）。
- `remoteLog(text)`（`src/remote-log.js`）：关键诊断推送 server。格式 `<模块>.<事件> key=value`。仅关键事件，**禁止高频**。
- **禁止在 auto-upgrade worker 进程中调 remoteLog**——worker 是独立 spawn 子进程，无 bridge 连接。

### Gateway RPC handler

- error 响应必须符合协议层错误形态：`respond(false, undefined, { code, message })`，code 用 ALL_CAPS（`INVALID_ARGS` / `IO_FAILED` / `INTERNAL_ERROR` 等）。**Why:** 直接 `respond(false, { error })` 是旧格式，下游解析不到结构化错误。helper 可用 `common/errors.js`（默认 `INTERNAL_ERROR`），或在模块内自带局部 helper（如 `provider-auth/handlers.js` / `model-default/handlers.js` 用本节约定的 `INVALID_ARGS` / `IO_FAILED` 而非 INTERNAL_ERROR，所以不走 common/errors.js）。
- 所有 handler 必须 `try/catch`。
- 成功响应**默认不 wrap**——payload 直接是纯业务对象（用命名字段，如 `{ profileId }` / `{ topics: [...] }`），空响应用 `respond(true, {})`。**Why:** 协议层 ResponseFrame 自带 ok 标志位 + error 通道，`{ status: ... }` 是 CoClaw CLI helper 的历史私有约定（不是协议要求）。**禁止 `respond(true, undefined)`**——上游 CLI `openclaw gateway call --json` 会崩 `endsWith` TypeError；空响应用 `{}` 占位绕开。设计 RPC method 前先看 `.agents/skills/gateway-method-design/SKILL.md`。
- 历史上 6 个 wrap 方法（`coclaw.bind/unbind/enroll/providerAuth.*`）已于 2026-05-16 全部去 wrap，仓库内不再有现存例子；详见 [`docs/gateway-method-conventions.md`](docs/gateway-method-conventions.md)。
- 新方法用 `coclaw.` 前缀。命名 / 错误码 / 历史遗物详见 [`docs/gateway-method-conventions.md`](docs/gateway-method-conventions.md)。

### Hook / RPC 双实例陷阱（`--link` 安装模式）

- `api.on()` 注册的 hook 与 `api.registerGatewayMethod()` 注册的 RPC handler **可能跑在不同 ESM 模块实例中**，即使同一进程、同一 `register()` 调用。原因：symlink 让 ESM 模块缓存按 URL 命中不同副本。
- **后果**：闭包捕获的对象（如 Manager 实例）看似同一个，**实际是两份独立内存拷贝**。Hook 改的 `__cache` 在 RPC handler 看不到。
- **应对**：跨 hook/RPC 共享的状态**不能依赖纯内存缓存**，必须经磁盘中转——读取侧每次从磁盘 reload。现有 `topic-manager` / `chat-history-manager` 是这套：lazy load + per-write atomic + `__cache.has(agentId) || await load()` 兜底；`session-manager` 是另一套——纯读时扫描 OpenClaw 的 `sessions.json` + JSONL，不写不缓存。
- `api.on` 在某些上下文（CLI mock API）可能不存在，注册时加 `typeof api.on === 'function'` 守卫。

### Service / register 副作用边界

- `realtime-bridge` 和 `auto-upgrade` scheduler **必须通过 `api.registerService()` 注册**，**禁止在 `register()` 直接启动**。**Why:** `register()` 在 CLI 上下文（`plugins install/uninstall`）也会被调用，直启会创建 WebSocket / 定时器导致进程退不出。
- `register()` 必须区分 `api.registrationMode`：`cli-metadata` 只 registerCli；其它非 `full` 模式（含 discovery，每 14s 一次）early return；只有 `full` 才能 `setRuntime` / 启 service / 注册 RPC。

### bind / unbind 共享层

- bind / unbind / enroll 的 CLI 是**瘦 CLI**：参数解析 → `callGatewayMethod` RPC → 展示结果。核心逻辑在 gateway 内 RPC handler。
- 所有 bind/unbind 核心逻辑集中在 `common/claw-binding.js`：RPC handler 与 `/coclaw bind` 斜杠命令共享 `doBind` / `doUnbind`。
- **禁止在 CLI 进程直接操作 `bindings.json`**——只走 RPC，让 gateway 统一管理 bridge 生命周期。
- **unbind 是强制操作**（非 best-effort）：server 不可达时 unbind 失败、不清本地 config，避免孤儿 bot。server 返回 401/404/410 视为 bot 已不存在，允许继续。

### Plugin 自发事件 patch 语义

- `broadcastPluginEvent(event, payload)`（`realtime-bridge.js` 导出）payload 按 **patch 语义**处理：server / UI 仅更新 payload 中实际出现的字段（`Object.hasOwn` 判定），缺失字段保留原值。
- **禁止 missing-as-null**——`coclaw.info.patch` handler 只发 `{ name, hostName }`，若 server 把缺失的 `pluginVersion` / `agentModels` 当 null 会清空 admin 仪表盘。
- 事件清单与字段约定见 [`docs/plugin-events.md`](docs/plugin-events.md)。

### 测试覆盖率门槛

- lines 100% / functions 100% / statements 100% / branches 95%。
- 未达标禁止安装到 gateway。

### 插件标识与安装

- 命名分四级且固定：npm 包 `@coclaw/openclaw-coclaw`、Plugin ID `openclaw-coclaw`（用于 `plugins.entries` / `plugins.installs` / `openclaw.plugin.json` 的 `id`，去 scope 后与 npm 包名一致避免 idHint mismatch）、Channel ID `coclaw`（channel 注册 / 消息路由 / state 子目录）、Command 名 `coclaw`（CLI `openclaw coclaw bind` / IM `/coclaw bind`）。改命名时同步检查 `openclaw.plugin.json` / `package.json` / `~/.openclaw/openclaw.json`，改完跑 `openclaw plugins doctor` + `plugins list` + `gateway status` 验证。
- Plugin id 三处必须严格对齐：`openclaw.plugin.json` 的 `id` ↔ 代码 `plugin.id` ↔ `~/.openclaw/openclaw.json` 的 `plugins.entries` key。`openclaw.plugin.json` 必须提供 `configSchema`（即使空对象 schema）。
- 安装/替换正确顺序：`openclaw plugins install <path>` → `openclaw gateway restart` → `openclaw gateway status` + `openclaw plugins doctor` 校验。**禁止**先手删 `<state-dir>/extensions/<plugin-id>` 再装。**Why:** `openclaw.json` 仍引用该 path 时，gateway 配置失效会启动告警/失败。若必须手删目录，先同步移除 `plugins.load.paths` 与对应 `plugins.entries`，再重启 gateway。

## topic → doc 索引

按需打开下面这些；不要默认全读。

| 触发场景 | doc |
|---|---|
| 不熟悉本插件 / 想看模块边界与数据流 | [`docs/architecture.md`](docs/architecture.md) |
| 加新 RPC method / 处理 scope / 双实例陷阱细节 | [`docs/gateway-method-conventions.md`](docs/gateway-method-conventions.md) |
| 加新 plugin 自发事件 / 事件 patch 语义细节 | [`docs/plugin-events.md`](docs/plugin-events.md) |
| 改 rpc DC 流控、分片、admission、白名单、ICE restart 行为 | [`docs/rpc-dc-send-queue.md`](docs/rpc-dc-send-queue.md) |
| 改/新增 res 帧或 event:agent 帧的路由分发 / 评估抽 reqId 表 | [`docs/rpc-routing.md`](docs/rpc-routing.md) |
| FBQ 设计 / admission 公式 / spill 边沿信号 / fsBroken 降级语义 | [`docs/rpc-dc-file-queue.md`](docs/rpc-dc-file-queue.md) |
| 改 WebRTC 实现选择 / 看 ndc-preloader 的命名困惑 / 评估清理死代码 | [`docs/webrtc-impl-strategy.md`](docs/webrtc-impl-strategy.md) |
| 升级 `@coclaw/pion-node` / 调试 pion-ipc 问题 | [`docs/pion-integration.md`](docs/pion-integration.md) |
| 本地开发安装 / link↔npm 切换 / 安装坑 | [`docs/local-plugin-update-sop.md`](docs/local-plugin-update-sop.md) |
| 自动升级机制 / 锁文件 / worker 行为 | [`docs/auto-upgrade.md`](docs/auto-upgrade.md) |
| 文件 I/O atomic write 设计 | [`docs/atomic-file-ops.md`](docs/atomic-file-ops.md) |
| OpenClaw plugin 安装/卸载机制 | [`docs/openclaw-plugin-management.md`](docs/openclaw-plugin-management.md) |
| 设备身份相关待办 | [`docs/device-identity-todo.md`](docs/device-identity-todo.md) |
| 设计 / 实施模型配置类 RPC（API key / OAuth / 默认模型 / 白名单） | [`docs/model-config-api.md`](docs/model-config-api.md) |

## TODO

预存问题列在 [`TODO.md`](TODO.md)。改动相关代码前先 grep 一下，避免重复发现。
