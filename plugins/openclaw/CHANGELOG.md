# @coclaw/openclaw-coclaw

## 0.15.0

### Minor Changes

- 1eedb69: plugin: 扩展 coclaw.info.updated payload

  - `__pushInstanceName` 改名为 `__pushInstanceInfo`
  - 事件 payload 新增 `pluginVersion`（从 `plugin-version.js` 获取）和 `agentModels`（agent × 有效主模型，通过 `agents.list` RPC 采集）
  - 新增 `__collectAgentModels` 方法；采集失败时 `agentModels` 为 null，不影响其它字段上报

## 0.14.1

### Patch Changes

- b2da826: chore(plugin): trim cancel-related diag log noise

  阶段 2.5 上线后实测发现取消相关日志噪音过大：注册空窗期内 UI 每 500ms 重试 `coclaw.agent.abort`，每次都打 `request` / `result not-found` / `not-found diag` 三条，单次取消可累积数十行；且 `installAbortRegistryDiag` 默认 patch 4 个 Map（其中 `reply.*` 在当前 OpenClaw 版本根本不暴露）+ 启动时每 label 一条 `installed ${label} patch (size=N)`。

  清理方案：

  - 删除已注释的 `[coclaw.agent.abort] request` info + `abort.request` remoteLog 行
  - `[coclaw.agent.abort] result` 在 `reason=not-found` 时跳过；`ok=true` / `not-supported` / `abort-threw` 仍 info
  - 删除 `agent-abort.js` 的 `not-found diag` 块 + `describeReplyRunRegistry` 助手 + 不再使用的 `logger` 形参
  - `PATCH_LABELS` 缩到只剩 `embedded.activeRuns`（取消路径实际读取的就是这张表；`sessionIdsByKey` 与之 1:1 同步触发，冗余；`reply.*` 当前 OpenClaw 不存在）
  - `patchMapLogging` 删掉 `clear` 包装（实测从未触发）+ 启动时的 `[coclaw.diag] installed ${label} patch` 日志（与 `abort.patch installed=` remoteLog 重复）

  最终噪音模型：每次 run 2 条 info（`embedded.activeRuns.set` + `.delete`）；取消成功 1 条 info + 1 条 remoteLog；`not-found` 重试期间完全静默。

  RPC 契约不变。

- 9c3833d: feat(plugin): add coclaw.env diag log with platform/version info on ws connect

  插件间接依赖平台相关二进制（`@coclaw/pion-ipc-*` 的 npm 平台子包），诊断问题时需要快速获取 claw 端的运行环境。新增 `coclaw.env` 单行诊断日志，覆盖 webrtc 选型 + 插件/OpenClaw 版本 + OS/arch/CPU/内存：

  ```
  coclaw.env impl=pion plugin=0.14.0 openclaw=4.5.0 platform=linux arch=x64 node=v22.22.0 osrel=6.6.87 cpu="AMD Ryzen 7 8745H" cores=8 mem=11.7GB
  ```

  **输出时机**：

  - `bridge.start()` 完成后：**只本地** `logger.info` 一次（gateway 日志可见，便于本地排查）
  - 每次 `ws.open`（首次连接 + 每次重连）：**只远程** `remoteLog` 一次

  两端互不重复：ws.open 是唯一的远程来源，避免 "start 入 buffer + ws.open 再发" 的重复问题；server 重启重连后能立即看到当前 claw 的环境信息。

  **关键设计**：

  - `getPlatformInfoLine()` 纯缓存的同步轻量调用（`process.*` 常量 + `os.release/cpus/totalmem`），模块级缓存一次后零开销，可被 ws 重连路径放心频繁调用
  - 显式避免 `process.report.getReport()`（重量级同步调用，曾怀疑与 native 模块初始化期产生时序冲突）
  - `ws.open` 内**先 `setRemoteLogSender` 再 `remoteLog(envLine)`**：保证环境信息随当前 sock 立即 flush；sender 闭包仅 `sock.send`，不回调 `remoteLog`，无循环依赖
  - 每字段独立 `try/catch` 尽力而为：单项失败不影响其它字段；CPU model 的控制字符（C0 + DEL）被清洗为空格以保证 `key="value"` 解析格式

  RPC 契约不变；gateway 方法注册不变；仅新增一条 remoteLog 日志。

- a9e209f: fix(ui,plugin): UI 主导的 cancel 协调状态机解决注册空窗期 race；插件诊断 patch 产品化 + remoteLog 触点

  阶段 2 上线后实测发现 topic "永远不能取消"、main chat "要等几秒才能取消"。根因：`agent()` RPC 的 `onAccepted` 帧毫秒级返回（UI 亮 STOP）但 OpenClaw 的 `setActiveEmbeddedRun`（`attempt.ts:1572`）要等 session/workspace/skills/provider 等异步准备完成才执行——main chat ~4s，topic 冷启 10-30s+。窗口内 `coclaw.agent.abort` 全部返回 not-found。

  阶段 2.5 实施 UI 主导 + 插件无状态方案：

  **UI 侧（`ui/src/stores/chat.store.js`）**

  - 新增 state `__cancelling = { sid, promise, resolve, tickTimer, tickSeq } | null`
  - 新增 getter `isCancelling`
  - 新增内部方法 `__startCancelCoordination(sid, conn)`：按 `CANCEL_TICK_MS = 500` 重试 `coclaw.agent.abort` RPC，**无 TTL**（生命期=run 生命期）
  - 终止信号：RPC ok=true → `{ok:true, aborted:'immediate'}`；RPC `not-supported` → 立即静默降级；每 tick 头检 `agentRunsStore.isRunning(runKey)`=false → `{ok:false, reason:'run-ended'}`；`sendMessage`/`sendSlashCommand` 入口 `__clearCancelling('superseded')` → `{ok:false, reason:'superseded'}`（deep-review 发现：缺此分支则 chat 模式同 sessionId 的新 run 会被残留 tick 误 abort）
  - `cancelSend` accepted 分支幂等：二次调用返回同一 promise（按钮已被 `cancelDisabled` 禁用）
  - `cleanup()` 同步清理 `tickTimer` 防止页面离开后继续重试
  - `ChatPage.vue` 的 `cancel-disabled` 集成 `isCancelling`——用户点 STOP 后按钮立刻禁用直到 run 结束
  - `onCancelSend` 简化：终态 `immediate`/`run-ended` 静默，仅 `not-supported` notify warning
  - UI remoteLog 触点：`cancel.start` / `cancel.immediate` / `cancel.not-supported` / `cancel.run-ended`

  **插件侧（`plugins/openclaw/`）**

  - `coclaw.agent.abort` 保持单次同步查询 + 现有 logger.info；新增 5 条 remoteLog 触点：`abort.request` / `abort.success` / `abort.not-supported` / `abort.patch installed=...` / `abort.patch-failed reason=...`
  - `installAbortRegistryDiag` 从 `/* c8 ignore */` 临时诊断**产品化**为常驻 patch：监控 `embedded.activeRuns` / `embedded.sessionIdsByKey` / `reply.activeRunsByKey` / `reply.activeKeysBySessionId` 四个 Map 的 `.set`/`.delete`/`.clear`，输出 `[coclaw.diag] <label>.set/delete/clear` 本地日志；installed/missing 列表上报 remoteLog 作为 OpenClaw 内部契约变更早期警报
  - `agent-abort.js` 的 `describeReplyRunRegistry` 与 not-found diag dump 同步产品化（去 c8 ignore + 补单测覆盖各种缺失/异常分支）

  **调研依据**：subagent 复核 OpenClaw 源码确认 sessionId → run 是 1:1（`runs.ts:359` 直接覆盖），run 中再发消息走 reply queue 4 模式但**无并发同 sid**；handle 不带 runId、`chat.abort` 的 runId 路径不覆盖 `agent()` RPC；故 CoClaw 维持 sid 粒度协调。queue 模式下 run A→B 转换由 lifecycle:end 自然清除 UI 协调状态，无残留意图误伤 B。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2.5、`docs/openclaw-research/agent-run-cancellation.md` §6.7。

- 397b36f: fix(ui,plugin): review followups for agent run cancellation

  deep review 发现的一致性/稳健性改进：

  - **ui**: 触屏"按住说话"按钮 gating 与 textarea / "+" 按钮对齐，改为仅受 `disabled` 控制（`sending` 单独禁用违反"accepted 后允许准备下次消息附件"的设计意图）
  - **ui**: `cancelSend` accepted 分支新增 settling(cancel) 守卫，避免双击 STOP / watcher 重入（如 `isClawOffline`）导致重复 `coclaw.agent.abort` RPC
  - **plugin**: `agent-abort.js` 增加 `typeof handle.abort !== 'function'` shape 守卫，归类为 `not-supported`（而非 `abort-threw`），让 UI notify 显示"升级 OpenClaw"而不是"执行失败"
  - **ui**: `POST_ACCEPT_TIMEOUT_MS` 注释修正 —— 这是客户端侧 fallback 上限，非与后端 run 生命周期对齐
  - 文档：`docs/architecture/communication-model.md` 超时表同步到最新值（agent post-accept 30min → 24h；generateTitle 300s → 600s，含层级说明）
  - 测试：补 `conn=null` 降级、双击 STOP 守卫、`title-gen.js` 传递 `timeoutMs=300_000` 断言、触屏语音按钮 gating

## 0.14.0

### Minor Changes

- 3d21a5e: feat(plugin): 新增 `coclaw.agent.abort` RPC，通过 OpenClaw 全局 symbol 侧门真正终止 embedded agent run

  该 RPC 接受 `{ sessionId: string }`，通过 `globalThis[Symbol.for('openclaw.embeddedRunState')].activeRuns.get(sessionId)?.abort()` 触发 OpenClaw 底层 `AbortController`，停止 LLM、工具调用和 compaction。

  响应语义是"请求是否被接纳"，并非"run 是否已终止"：

  - `{ ok: true }`：handle.abort 已调用，取消是否真生效由随后的 `lifecycle:end` 事件反映
  - `{ ok: false, reason: 'not-supported' }`：侧门不存在（OpenClaw < v2026.3.12）
  - `{ ok: false, reason: 'not-found' }`：sessionId 未在 activeRuns 中（已完成 / 从未开始 / 竞态）
  - `{ ok: false, reason: 'abort-threw', error }`：handle.abort 抛异常（不期望但防御）

  侧门访问封装在新文件 `src/agent-abort.js`，未来上游若提供正式 `agent.abort` RPC 或在 `api.runtime.agent` 暴露 abort 家族可集中替换。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2。

- 1aa1345: feat(plugin): 为 rpc DC 引入应用层发送流控（RpcSendQueue）

  - 每条 rpc DC 绑定一个 `RpcSendQueue` 实例，`broadcast` / files RPC sendFn 经此出口
  - 阈值：HIGH=1MB / LOW=256KB 水位背压；队列软上限 10MB（单条可溢出）；单条硬上限 50MB
  - 溢出静默丢弃（logger.warn 每次；remoteLog 仅状态转换汇总）
  - probe-ack 故意绕过 queue，独立测量传输层健康
  - 避免 pion/webrtc Go 侧 SCTP pendingQueue 无界堆积导致 gateway OOM

### Patch Changes

- ecebf2a: bump @coclaw/pion-node to ^0.1.2（新增 linux-arm 平台二进制支持）
- 3f9c0ef: fix(plugin): topic 标题生成内部 agentRpc 超时 60s → 5min

  原 60s 在慢模型 / 复杂对话下普遍超时，导致 `coclaw.topics.generateTitle` 失败。调高到 300s 给 LLM 足够的推理时间。`acceptTimeoutMs` 保持 10s（accept 阶段一般秒级完成）。

- 6dddcf9: fix(plugin): rpc DC 生命周期与诊断收尾（深度 review followups）

  - `closeByConnId`：显式关闭 `RpcSendQueue`（避免 `dc.onclose` 路径因 session 已 delete 而短路，导致 drop 汇总 remoteLog 缺失）
  - ICE restart：重协商 SDP 后同步刷新 `remoteMaxMessageSize` 与 queue 分片阈值（避免 renegotiation 变更 `a=max-message-size` 时新消息按旧值错误分片）
  - `rtc.dump` 诊断增加 `queueLen/queueBytes/dropped` 字段，便于定位队列积压
  - `agent-abort`：`activeRuns.get()` 也纳入 try/catch，duck-typed 实现抛出时归入 `abort-threw`（原先仅保护 `handle.abort()`）

## 0.13.2

### Patch Changes

- fix(plugin): 修复 PionIpc listener 泄漏并添加 failed session 清理机制

  - failed 状态的 session 增加 24h TTL 定时器，超时后自动回收释放 IPC listeners 和 Go 侧资源
  - session 总数上限 20，溢出时淘汰最旧的 failed session
  - closed 状态通过 closeByConnId 完整释放资源（此前仅删除 Map 条目）

## 0.13.1

### Patch Changes

- 优化 ICE restart 恢复时序与实现门控

## 0.13.0

### Minor Changes

- feat: pion-ipc WebRTC 实现 + ICE restart 恢复策略 + 文件传输诊断增强

  - 新增 pion-ipc preloader（autoRestart watchdog），WebRTC 优先级：pion → ndc → werift
  - ICE restart-first 连接恢复：断连时优先 ICE restart，失败发送 restart-rejected 由 UI 驱动 full rebuild
  - connectionState failed 保留 session 以支持 ICE restart 恢复
  - 文件传输增加 dc.onerror 处理（兼容 pion 异步 send 错误）、进度日志、诊断 dump
  - dc.close() 改为 await（pion graceful close 支持）
  - 分片阈值取 min(远端 max-message-size, 本地 maxMessageSize)
  - pion-node 依赖升级至 ^0.1.1

## 0.12.3

### Patch Changes

- fix: improve Windows compat for auto-upgrade subprocess calls; use ws package for WebSocket to bypass undici proxy dispatcher

## 0.12.2

### Patch Changes

- Register libdatachannel initLogger to capture native ICE/DTLS/SCTP diagnostics via remoteLog

## 0.12.1

### Patch Changes

- fix: upgrade node-datachannel to v0.32.2, add backpressure and diagnostic logging to DC file upload

## 0.12.0

### Minor Changes

- refactor: rename bot→claw in API paths, config persistence, WS messages, and internal identifiers

## 0.11.6

### Patch Changes

- fix(plugin): 修正 ndc-preloader 的 pluginRoot 路径计算（`..` → `../..`），修复 npm 安装用户无法加载 vendor 预编译包导致 fallback 到 werift 的问题

## 0.11.5

### Patch Changes

- 77afc35: feat(plugin): 启动时 remoteLog 插件版本号；自动升级检测到结果时远程上报（成功/回滚/跳过）

## 0.11.4

### Patch Changes

- fix(plugin): stop() 不调用 ndc.cleanup() 避免阻塞事件循环 10s+ 导致 bind/unbind 超时；修复 callGatewayMethod 未传递 --timeout 给 openclaw gateway call 的问题

## 0.11.3

### Patch Changes

- fix: percent-encode TURN credentials for node-datachannel

## 0.11.2

### Patch Changes

- fix: support turns: URL scheme in ICE server credential mapping

## 0.11.1

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.11.0

### Minor Changes

- feat: add claw instance naming support

  - New `coclaw.info.get` / `coclaw.info.patch` gateway methods for reading/setting claw name
  - Claw name stored in `~/.openclaw/coclaw/settings.json`, independent of bindings
  - `coclaw.info.updated` event broadcast to server (persists bot.name) and UI instances (DC)
  - `coclaw.info` response now includes `name` and `hostName` fields

## 0.10.0

### Minor Changes

- Integrate node-datachannel as primary WebRTC implementation with werift fallback

  - Add ndc-preloader module with vendor prebuild deployment, timeout protection, and graceful fallback
  - Unify PeerConnection resolution: preloader provides implementation, webrtc-peer requires it
  - Await preload before WS connection to eliminate RTC timing gap
  - Add self-explanatory diagnostic logging for WebRTC implementation selection
  - Include precompiled binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64

## 0.9.2

### Patch Changes

- fix: WebRTC init race condition + reconnect unhandled rejection

## 0.9.1

### Patch Changes

- fix: add error listener on spawned upgrade worker to prevent gateway crash

## 0.9.0

### Minor Changes

- 4152fcd: 文件管理协议升级：采用 HTTP 动词语义（GET/PUT/POST），新增 POST 附件上传（唯一文件名生成）、mkdir/create RPC、force delete 非空目录支持

## 0.8.2

### Patch Changes

- feat(rtc): DataChannel 应用层分片/重组，消除 SCTP maxMessageSize 限制，所有 RPC 消息统一走 DataChannel

## 0.8.1

### Patch Changes

- fix(webrtc): correct ICE restart handling and fix session cleanup race

## 0.8.0

### Minor Changes

- feat: implement file management via WebRTC DataChannel (list/delete/read/write with path security, backpressure flow control, and temp file cleanup)

## 0.7.1

### Patch Changes

- fix: rename internal function to avoid OpenClaw install-time security scanner warning

## 0.6.2

### Patch Changes

- Delegate bind/unbind to gateway RPC, harden config I/O with atomic writes and mutex, improve error handling in realtime bridge

## 0.6.1

### Patch Changes

- e2528cc: coclaw.info RPC 新增 clawVersion 字段，返回 OpenClaw 版本号（当上游 resolveVersion() 可用时）

## 0.6.0

### Minor Changes

- Add claim-bind (enroll) flow for OpenClaw-initiated binding; align gateway method error response format with OpenClaw protocol; fix shell mangling JSON params in gateway RPC calls

## 0.5.2

### Patch Changes

- fix(bridge): 从环境变量 OPENCLAW_GATEWAY_PORT 自动检测 gateway 端口，不再硬编码 18789。修复非默认端口的 OpenClaw 实例绑定后所有 RPC 失败（"Gateway is offline"）的问题。

## 0.5.1

### Patch Changes

- fix(plugin): coclaw.info 等待 ensureAllAgentSessions 完成后再响应，修复新 OC 实例首次连接时空 session 导致无法进入对话页面的问题

## 0.5.0

### Minor Changes

- 新增 chat 历史追踪与统一消息加载能力：
  - ChatHistoryManager：通过 session_start 钩子追踪 chat reset 产生的孤儿 session，持久化到 coclaw-chat-history.json
  - coclaw.chatHistory.list RPC：供 UI 查询指定 chat 的孤儿 session 链
  - coclaw.sessions.getById RPC：按 sessionId 返回完整 JSONL 行级消息（type + id + message），替代 nativeui.sessions.get
  - coclaw.info capabilities 新增 chatHistory
  - 修复 recordArchived 竞态：在 mutex 内先从磁盘重载，防止 list() 无锁覆写缓存导致数据丢失

## 0.4.1

### Patch Changes

- 新增 coclaw.topics.update gateway 方法，支持通过 RPC 更新 topic 标题；修复 changes 不含有效字段时静默成功的问题

## 0.4.0

### Minor Changes

- feat(plugin): add Topic management support

  - New `src/topic-manager/` module with `TopicManager` class (in-memory model + `coclaw-topics.json` persistence per agentId, using mutex + atomicWriteJsonFile)
  - New `src/topic-manager/title-gen.js` for AI-powered title generation (copy `.jsonl` transcript, invoke agent via gateway WS two-phase RPC, clean title text, update topic metadata, cleanup temp files)
  - Extended `realtime-bridge.js` with `__gatewayAgentRpc` method supporting agent() two-phase response protocol (accepted -> final), exposed via singleton `gatewayAgentRpc()`
  - Registered 7 new gateway methods: `coclaw.info`, `coclaw.topics.create`, `coclaw.topics.list`, `coclaw.topics.get`, `coclaw.topics.getHistory`, `coclaw.topics.generateTitle`, `coclaw.topics.delete`
  - `coclaw.info` returns plugin version and capabilities list for UI version/feature checking
  - Topic data stored at `~/.openclaw/agents/<agentId>/sessions/coclaw-topics.json`, leveraging OpenClaw's per-agent sessions directory isolation

## 0.3.2

### Patch Changes

- fix: declare tool-events capability for gateway connection, enabling tool call streaming events

## 0.3.1

### Patch Changes

- fix: bind 后 OpenClaw 始终离线的回归问题（需重启 gateway 才能上线）

## 0.3.0

### Minor Changes

- feat: add multi-agent session ensure support for OpenClaw nativeui.sessions.ensure gateway method

## 0.2.4

### Patch Changes

- 4f89f91: fix(plugin): add device identity to gateway WS connection for OpenClaw 3.12+ scope enforcement

  OpenClaw 3.12 introduced a security fix (CVE GHSA-rqpp-rjj8-7wv8) that strips scopes from WS connections without device identity. This caused `nativeui.sessions.listAll` and `agent.identity.get` calls to fail with "missing scope" errors.

  - Add `src/device-identity.js`: Ed25519 key pair generation, storage (`~/.openclaw/coclaw/device-identity.json`), and v3 auth payload signing
  - Modify `realtime-bridge.js`: capture nonce from `connect.challenge`, build signed `device` field in connect params
  - Device identity is auto-generated on first connection and cached for subsequent reconnects
  - Backward compatible with OpenClaw >= 2026.2.19

## 0.2.3

### Patch Changes

- realtime-bridge 心跳超时改为连续 miss 计数策略（4 次 ~3 分钟），避免大消息传输期间误断连

## 0.2.1

### Patch Changes

- fix: auto-upgrade logger 兼容 gateway pino 风格，修复 "log is not a function" 导致升级流程中断的问题

## 0.1.7

### Patch Changes

- - fix: prevent bot.unbound race condition and fix bridge reconnect after rebind
  - feat: auto-rebind on bind and add request timeouts
  - fix: strip operator-configured policy prefix in derivedTitle
  - fix: enhance derivedTitle cleaning for cron time and untrusted context
  - refactor: architecture cleanup before auto-upgrade feature

## 0.1.6

### Patch Changes

- fix: unbind 时无论 server 通知是否成功，都清理本地绑定信息，避免用户陷入无法 unbind 也无法 bind 的死锁状态

## 0.1.5

### Patch Changes

- Fix server URL resolution: correct plugin entries key, default to im.coclaw.net, unbind and realtime-bridge use bindings.json as authoritative source

## 0.1.4

### Patch Changes

- fix(plugin): session get returns empty messages instead of throwing when transcript file missing

## 0.1.3

### Patch Changes

- fix(plugin): handle missing .jsonl for agent:main:main sessionKey and ensure it exists on startup

## 0.1.2

### Patch Changes

- fix(plugin): align plugin id with npm package name (openclaw-coclaw)
