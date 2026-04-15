# @coclaw/ui

## 0.14.0

### Minor Changes

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

### Patch Changes

- 397b36f: fix(ui,plugin): review followups for agent run cancellation

  deep review 发现的一致性/稳健性改进：

  - **ui**: 触屏"按住说话"按钮 gating 与 textarea / "+" 按钮对齐，改为仅受 `disabled` 控制（`sending` 单独禁用违反"accepted 后允许准备下次消息附件"的设计意图）
  - **ui**: `cancelSend` accepted 分支新增 settling(cancel) 守卫，避免双击 STOP / watcher 重入（如 `isClawOffline`）导致重复 `coclaw.agent.abort` RPC
  - **plugin**: `agent-abort.js` 增加 `typeof handle.abort !== 'function'` shape 守卫，归类为 `not-supported`（而非 `abort-threw`），让 UI notify 显示"升级 OpenClaw"而不是"执行失败"
  - **ui**: `POST_ACCEPT_TIMEOUT_MS` 注释修正 —— 这是客户端侧 fallback 上限，非与后端 run 生命周期对齐
  - 文档：`docs/architecture/communication-model.md` 超时表同步到最新值（agent post-accept 30min → 24h；generateTitle 300s → 600s，含层级说明）
  - 测试：补 `conn=null` 降级、双击 STOP 守卫、`title-gen.js` 传递 `timeoutMs=300_000` 断言、触屏语音按钮 gating

## 0.11.3

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.9.4

### Patch Changes

- feat: 管理员仪表盘新增最新注册用户列表；服务端新增插件版本号返回及 loginName 查询
- fix: 管理员仪表盘修复版本号显示、用户名为空、在线数未展示、文案优化；Dashboard 频道名称显示及花费隐藏；统一 **APP_VERSION** 变量

## 0.9.0

### Minor Changes

- 7044e4f: feat: 机器人页面升级为 Agent Dashboard（Phase 1）

  - 新增实例总览卡片（InstanceOverview）：展示名称、在线状态、本月花费、频道状态、版本信息
  - 新增 Agent 卡片瀑布流（AgentCard）：展示身份、模型标签、能力矩阵、tokens/会话/最近活跃
  - 能力标签从 OpenClaw gateway tools.catalog 动态映射
  - 模型标签从 models.list 动态生成
  - 并行 RPC 聚合，部分失败优雅降级
  - 离线 bot 显示简化版 fallback header
  - 完善 i18n 支持（中文 + 英文）

## 0.1.1

### Patch Changes

- 0cf6cec: fix(ui,server): add WS heartbeat and improve chat disconnect resilience

  - UI WS client: 25s ping / 45s timeout heartbeat to detect silent disconnections on mobile
  - Server: respond to application-level ping/pong + WS protocol-level ping for UI connections
  - ChatPage: 30s pre-acceptance timeout to prevent infinite "thinking" state
  - ChatPage: suppress duplicate error toasts when timeout/lifecycle:end already handled
  - ChatPage: lifecycle:end uses fresh WS connection for refresh; preserves user message on failure

- fix(server,ui): accumulated fixes since changeset adoption

  - server: extend binding code expiry from 5 to 30 minutes
  - server,ui: push bot name update via SSE after bridge connects
  - ui: update plugin id to openclaw-coclaw and improve AddBot page layout
  - ui: distinguish bot offline from unbound in ChatPage notification
  - ui: remove redundant bind-success notify and guard unbind double-click
  - plugin,ui: fix new-chat failure and missing session for agent:main:main
