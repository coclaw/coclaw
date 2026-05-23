# 模块边界：稳定 API vs 内部 + module-level 单例 link-safety

> 范围：本插件所有模块。
> 状态：当前真相。

本 doc 解决两个相关问题：

1. 即将发布到 hub 前，需要明确 `realtime-bridge.js` 里**哪些导出是稳定的公共 API、哪些是内部**——避免外部依赖把内部细节锁死。
2. `--link` 安装模式下 hook 与 RPC handler 跑在不同 ESM 实例（CLAUDE.md "Hook / RPC 双实例陷阱"），需要把所有 module-level 单例盘一遍，标记 link-safe / link-unsafe。

两个问题都围绕"模块导出边界"，合在一份 doc 里。

---

## A. realtime-bridge.js：稳定 API vs 内部

`src/realtime-bridge.js` 当前导出列表（含 module-level 状态）：

| 导出 | 性质 | 公共 / 内部 | 备注 |
|---|---|---|---|
| `GATEWAY_RETRY_DELAYS_MS` | 只读常量 | 内部 | 仅 plugin 自己用；不承诺稳定 |
| `classifyAgentLagStop(payload)` | 纯函数 | 内部 | lag-probe 用 |
| `isFinalResMsg(frame)` | 纯函数 | 内部 | 帧识别 helper |
| `defaultResolveGatewayAuthToken()` | 纯函数 | 内部 | gateway 鉴权 token 回填 |
| `class RealtimeBridge` | class | 内部 | 直接 new 旁路了 singleton，不承诺稳定 |
| `restartRealtimeBridge(opts)` | 操作 singleton | **公共** | 启动 / 重启 bridge 的唯一入口 |
| `stopRealtimeBridge({forceCleanup})` | 操作 singleton | **公共** | 关闭 bridge 的唯一入口 |
| `waitForSessionsReady()` | 读 singleton | **公共** | 启动期等 sessions 就绪 |
| `ensureAgentSession(agentId)` | 读 singleton | **公共** | 标题生成、chat-history 等用 |
| `gatewayAgentRpc(method, params, opts)` | 读 singleton | **公共** | 两阶段 agent RPC 入口 |
| `broadcastPluginEvent(event, payload)` | 读 singleton | **公共** | 插件自发事件广播 |
| `__getSingletonForTest()` | 读 singleton | **测试专用** | `__` 前缀；生产代码勿调 |

### 公共 API 的契约

- 调用方仅通过 6 个"公共" 函数 + 1 个测试函数 与 bridge 交互；不要直接 `new RealtimeBridge` 或读其它 export。
- singleton 生命周期由 `restartRealtimeBridge` / `stopRealtimeBridge` 管理；调用者不应感知 singleton 是否为 null（"要运行 / 要停止"二选一）。
- 6 个公共函数中除 `restart` / `stop` 外，singleton 未初始化时**不抛**，而是返回 `{ ok: false, error: 'bridge_not_started' }` 或安静 no-op（详见 `broadcastPluginEvent`）。

### 不承诺稳定的部分

- 任何不在上表"公共"行里的 export（含 class、纯函数、常量）。
- `RealtimeBridge` 实例上的所有 `__` 前缀方法 / 字段。
- 任何未经文档声明的副作用（如内部 lag-probe 计时、退避节奏）。

### Hub 发布后的"破坏性变更"判定

仅当 **公共行的 6 个入口签名、返回形态、副作用语义** 发生变化才算 breaking。中间所有重构（class 拆分、内部 helper 重命名、移到子模块）都不算 breaking。

### Future work

`src/realtime-bridge.js` 仍是 1700+ 行的"上帝模块"，承载双 WS 桥接 + WebRTC 信令路由 + 设备握手 + 心跳 + 退避重连 + lag-probe + 事件广播 + 路由表。中长期应拆成几个能独立测的子模块（如 gateway-ws 握手机 + lag-probe / WebRTC 信令路由器）。本节钉死了"对外契约"——拆模块时只要保住 7 个导出入口，不影响下游。

---

## B. Module-level 单例 link-safety 清单

`--link` 模式下，同一进程内 hook 与 RPC handler 可能拿到**不同 ESM 模块实例**（symlink 让 ESM cache 按 URL 命中不同副本）。每份模块的 module-level `let` 状态都会有两份独立内存拷贝；hook 改的版本，RPC handler 看不到。

下表盘一遍：

| 文件 | module-level 状态 | link-safe? | 后果 / 应对 |
|---|---|---|---|
| `src/realtime-bridge.js` | `let singleton` | **link-UNSAFE** | hook 调本文件公共导出会拿到另一份 singleton；详见 §A "hook 路径不要调"。 |
| `src/runtime.js` | `let runtime` | **link-UNSAFE** | hook 取到的 runtime 可能是 null（discovery 实例里没被 setRuntime 过）。所有 hook 内只通过 `api`（hook 入参）取 runtime，**不**调 `getRuntime()`。 |
| `src/remote-log.js` | `let sender` / `let flushing` / `const buffer` | **link-UNSAFE** | 每份实例自己一套 buffer 与 flush 状态；hook 路径调 `remoteLog()` 可能落到没装 sender 的实例 → 静默丢日志。`setSender` 只调用一次（register 时），hook 内**避免**新调 `remoteLog`；要发就用 hook 入参里的 logger。 |
| `src/plugin-version.js` | `let __pluginVersion` | link-safe（缓存重复无害） | 两实例各自首次调用各读一次 `package.json`；结果相同。允许 hook / RPC 都调。 |
| `src/platform-info.js` | `let __cachedLine` | link-safe（缓存重复无害） | 同上：纯派生 + 幂等。 |
| `src/provider-auth/index.js` | `let _sdkPromise` | **link-UNSAFE**（dedup 失效） | 两实例可能各 lazy-load 一次 SDK；当前仅 RPC handler 走该路径，hook 内不应直接动；运行无伤但浪费。 |
| `src/model-default/index.js` | `let _configMutationP` / `_modelsP` / `_providerAuthP` | **link-UNSAFE**（dedup 失效） | 与上同；当前仅 RPC handler 入口，不在 hook 路径。 |
| `src/topic-manager/manager.js` | `this.__cache` 实例字段 | link-safe（已用磁盘中转） | manager 是 per-agentId lazy load + atomic write + `__cache.has` 兜底，跨实例 / 跨进程读都走磁盘。详见 CLAUDE.md "Hook / RPC 双实例陷阱" §应对。 |
| `src/chat-history-manager/manager.js` | `this.__cache` 实例字段 | link-safe（已用磁盘中转） | 同上。 |
| `src/session-manager/manager.js` | 无 | link-safe | 纯读 OpenClaw 自家文件，不缓存。 |
| `index.js` | `let __pluginInitDone` | **link-UNSAFE** | `awaitPluginInit()` 返回的是当前模块实例的 init bundle；link 模式双 ESM 实例下，从另一份副本调入会拿到默认 `Promise.resolve()`（非真实 register 那次的 bundle）。当前唯一调用方是同一份模块内的 `index.test.js`，生产 gateway 不调，影响仅限测试。**register full 模式新增任何 fire-and-forget 副作用都必须合入 `__pluginInitDone`**（详见 CLAUDE.md "Service / register 副作用边界"）。 |

### Link-UNSAFE 的"硬约束"

凡是上表标 link-UNSAFE 的模块，导出函数都**不应在 hook 回调内调用**（`api.on('session_start', ...)` 等）。判断标准：

- hook 内只用 hook 入参（含 `api`、payload）拿运行时能力。
- 跨 hook 与 RPC 共享的状态走磁盘中转（参考 topic-manager / chat-history-manager）。
- 必须在 hook 内触发 bridge 副作用时（如发广播）——通过 `api.callGatewayMethod('coclaw.xxx', ...)` 走 RPC，让 RPC handler 实例（与 RPC 注册同实例）来实际动 bridge。

### Future work

如果未来真的需要 hook 与 RPC 共享 bridge 控制权，治本路径是把"跨 hook/RPC 共享状态"全部强制走磁盘中转（或单独的 IPC channel），让模块导出层不再承载 mutable singleton。当前 hook 入口未使用 bridge 的公共 API，所以这件事可以延后；新增 hook 时先看本表，确认要调的 export 是否 link-safe。

---

## C. 历史出处

- 2026-05-09 pre-hub release 设计 review 识别"realtime-bridge 是 1700 行的上帝模块"（原 `TODO.md` 同名条目）。
- 同期识别"`--link` 双实例陷阱在桥接层与其它 module-level 单例上未系统排查"（原 `TODO.md` 同名条目）。
- 两条 TODO 已并入本 doc，原条目移除。
