---
"@coclaw/ui": minor
"@coclaw/openclaw-coclaw": minor
---

fix(ui,plugin): UI 主导的 cancel 协调状态机解决注册空窗期 race；插件诊断 patch 产品化 + remoteLog 触点

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
