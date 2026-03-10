# ensureMainSessionKey Bug 分析与修复

> 日期：2026-03-03
> 修复日期：2026-03-10
> 状态：已修复（方案 A）
> 关联代码：`src/realtime-bridge.js` — `ensureMainSessionKey()`

## 背景

插件在 gateway WebSocket 连接成功后调用 `ensureMainSessionKey()`，意图确保 `agent:main:main` sessionKey 始终存在。

## 原始 Bug 详情

### Bug 1：响应路径错误

原代码从 `resolved?.response?.result?.entry?.sessionId` 读取 sessionId。

但 OpenClaw 网关的 WebSocket 响应格式会将 handler 返回值包裹在 `payload` 字段中（参见 `ResponseFrameSchema`）：

```json
{
  "type": "res",
  "id": "<id>",
  "ok": true,
  "payload": { ... }
}
```

正确的路径应为 `resolved?.response?.payload?.result?.entry?.sessionId`。

### Bug 2：`sessions.resolve` 根本不返回 `entry`/`sessionId`

即便修正了路径，`sessions.resolve` 也不包含 `entry` 或 `sessionId`。

OpenClaw 源码（`src/gateway/server-methods/sessions.ts:403`）：

```typescript
respond(true, { ok: true, key: resolved.key }, undefined);
```

实际 WebSocket 响应：

```json
{
  "type": "res",
  "ok": true,
  "payload": { "ok": true, "key": "agent:main:main" }
}
```

### 影响链（修复前）

1. `resolvedSessionId` 永远为 `undefined` → 判断条件永远失败
2. 代码总是走到 `sessions.reset({ key, reason: 'new' })` → **对话被重置**
3. 每次 WebSocket 重连，函数再次执行 → **再次重置对话**

## 修复方案（已实施：方案 A 简化判断逻辑）

`sessions.resolve` 返回 `ok: true` 即表示该 sessionKey 存在，无需提取 `sessionId`：

```javascript
const resolved = await gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
if (resolved?.ok === true) {
  mainSessionEnsured = true;
  return { ok: true, state: 'ready' };
}
```

增加了瞬态错误防御——仅当网关真实响应 "不存在" 时才创建，超时等瞬态错误不触发 reset：

```javascript
if (!resolved?.response) {
  return { ok: false, error: resolved?.error ?? 'resolve_transient_failure' };
}
```

重置后也只需检查 `reset.ok === true`，不必再做二次 verify：

```javascript
const reset = await gatewayRpc('sessions.reset', { key, reason: 'new' }, { timeoutMs: 2500 });
if (reset?.ok !== true) {
  return { ok: false, error: reset?.error ?? 'sessions_reset_failed' };
}
mainSessionEnsured = true;
return { ok: true, state: 'created' };
```

## 行为保证

- `mainSessionEnsured` 标志确保进程存活期间只在首次 gateway 连接时执行 ensure
- `stopRealtimeBridge()` 会重置 `mainSessionEnsured`，下次 start 时重新 ensure
- 瞬态错误（超时、网关未就绪）不会触发 reset，避免误删对话
