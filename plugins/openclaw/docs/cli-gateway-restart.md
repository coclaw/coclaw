# CLI bind/unbind 后通知 Gateway

## 问题根因

CLI (`coclaw bind/unbind`) 和 OpenClaw Gateway 是两个独立进程：

- **CLI 进程**：用户在终端执行，修改本地绑定信息（`~/.openclaw/coclaw/bindings.json`）后退出
- **Gateway 进程**：长驻后台，运行插件代码，维护 realtime bridge 连接

配置文件变更无法跨进程通知 —— CLI 写入新配置后，Gateway 进程中的 realtime bridge 不会自动重连或断连。

## 两条绑定路径的差异

### 插件命令路径（`/coclaw bind`）

用户在聊天界面执行 `/coclaw bind <code>`，由 `index.js` 中的命令处理器处理。
因为运行在 Gateway 进程内，可以直接调用 `restartRealtimeBridge()` / `stopRealtimeBridge()` 触发连接状态变更。

### CLI 路径（`coclaw bind`）

用户在终端执行 `coclaw bind <code>`，由 `src/cli.js` 或 `src/cli-registrar.js` 处理。
CLI 是独立进程，无法调用 Gateway 进程内的函数。

## 解决方案

### 方案演进

早期方案是 CLI 在 bind/unbind 成功后通过 `execSync('openclaw gateway restart')` 重启整个 Gateway 进程。但这存在两个问题：

1. **重启代价大**：所有插件和服务都要重新加载，耗时 ~20 秒
2. **影响范围广**：仅需刷新 CoClaw bridge，却要重启整个 gateway

### 当前方案：Gateway RPC 通知 + spawn（2026-03-05）

插件在 `register()` 中注册两个 gateway methods：

- `coclaw.refreshBridge` — 停止并重新启动 realtime bridge（用于 bind 后）
  - 成功时返回 `respond(true, { status: 'refreshed' })`
- `coclaw.stopBridge` — 停止 realtime bridge（用于 unbind 后）
  - 成功时返回 `respond(true, { status: 'stopped' })`

CLI 在 bind/unbind 成功后，通过 `openclaw gateway call <method> --json` 发送轻量 RPC 请求通知 gateway 内的插件服务。

#### execSync 进程不退出坑位（2026-03-05 修复）

**问题**：初版使用 `execSync('openclaw gateway call <method>', { timeout: 10000 })` 调用 gateway RPC。但 `openclaw gateway call` 内部使用 `GatewayClient`（WebSocket）完成 RPC 后，虽然调用了 `client.stop()`，WebSocket handle 未完全销毁，Node.js 事件循环仍然活跃，导致进程不退出。`execSync` 等待的是**进程退出**而非**输出完成**，因此即使 RPC 在 ~2 秒内成功完成，10 秒后仍然超时抛异常 —— **100% 误报失败**。

**解决方案**：将 `execSync` 替换为 `spawn`（异步），核心逻辑封装在 `src/common/gateway-notify.js` 的 `callGatewayMethod()` 中：

1. spawn 子进程执行 `openclaw gateway call <method> --json`
2. 监听 stdout，解析 JSON 输出判断 RPC 成功/失败
3. 检测到输出后延迟 2 秒再 kill 子进程（给进程自然退出的机会）
4. 总超时 10 秒（覆盖 gateway 不存在/重启中等场景）
5. 无论成功失败，最终都主动 kill 子进程

**RPC 返回值约定**：

| 场景 | respond() 调用 | `openclaw gateway call --json` stdout |
|------|-------------|-------------|
| refreshBridge 成功 | `respond(true, { status: "refreshed" })` | `{ "status": "refreshed" }` |
| stopBridge 成功 | `respond(true, { status: "stopped" })` | `{ "status": "stopped" }` |
| 失败 | `respond(false, { error: "..." })` | CLI 抛异常，非零退出码 |

**重要**：`openclaw gateway call --json` 直接输出 method 的 result payload（即 `respond()` 的第二个参数），
而非 gateway 协议层的 `{ ok, result, error }` 包装。CLI 的判断策略：

1. 收到 stdout 且能解析为 JSON → 视为 RPC 成功
2. 收到 stdout 但非 JSON → 也视为成功（兜底）
3. 无 stdout + 非零退出码 → RPC 失败
4. 无 stdout + 超时 → RPC 失败

此外，stdout 检测到完整 JSON 后，启动 **2 秒 grace period**：
- 若进程在 2 秒内自然退出（`close` 事件），立即 resolve
- 若 2 秒后进程仍未退出，主动 kill 并 resolve

这样设计是因为 `openclaw gateway call` 完成 RPC 后，进程可能因 WebSocket handle 未清理而滞留 10+ 秒才退出。
grace period 的目的是：当未来 OpenClaw 修复了 WebSocket 清理问题后，进程能优雅退出而无需被 kill。

### 优点

- 利用 OpenClaw 内建的 gateway WebSocket RPC 通道
- 只刷新 CoClaw bridge，不影响 gateway 中其他插件和服务
- CLI 执行耗时从 ~20 秒降至 ~2 秒
- 正确检测 RPC 成功/失败，不再误报

## realtime bridge 生命周期

bridge 通过 `api.registerService()` 注册为 gateway service：

- `start()` — gateway 启动时自动调用，建立到 CoClaw server 的 WebSocket 连接
- `stop()` — gateway 关闭时自动调用，清理连接

这确保了 bridge 只在 gateway daemon 运行时启动，CLI 上下文下（如 `openclaw plugins install/uninstall`）不会创建 WebSocket 连接。

## 测试注入

`main()` 和 `registerCoclawCli()` 接受可选的 `deps` 参数，其中 `deps.spawn` 可替换 `callGatewayMethod` 中的 `node:child_process.spawn`，用于单元测试中 mock 通知行为。

## 补充：gateway 自动重启与 RPC 通知的区别

OpenClaw gateway 通过 chokidar 监听 `openclaw.json`，`plugins.*` 路径变更会触发自动全量重启。但 CoClaw 的绑定信息存储在独立的 `bindings.json` 中，**不会触发此机制**。因此 CLI bind/unbind 必须通过 RPC 主动通知插件刷新 bridge。

| 操作 | 配置文件 | 是否触发自动重启 | 通知方式 |
|------|----------|-----------------|---------|
| `openclaw plugins install/uninstall` | `openclaw.json` | 是（`plugins.*` 变更） | 无需额外通知 |
| `coclaw bind/unbind` | `bindings.json` | 否 | Gateway RPC（本文档描述） |

详见 `docs/openclaw-plugin-management.md`。
