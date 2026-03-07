# ensureMainSessionKey Bug 分析

> 日期：2026-03-03
> 状态：功能已禁用，待修复
> 关联代码：`src/realtime-bridge.js` — `ensureMainSessionKey()`

## 背景

插件在 gateway WebSocket 连接成功后调用 `ensureMainSessionKey()`，意图确保 `agent:main:main` sessionKey 始终存在。实际效果是每次 WebSocket 重连都会误触 `sessions.reset`，导致用户对话被频繁重置。

## Bug 详情

### Bug 1：响应路径错误

代码从 `resolved?.response?.result?.entry?.sessionId` 读取 sessionId。

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

OpenClaw 自身的集成测试也确认了这一点：

```typescript
const resolvedByKey = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
  key: "main",
});
expect(resolvedByKey.payload?.key).toBe("agent:main:main");
// 没有 entry/sessionId 的断言
```

### 影响链

1. `resolvedSessionId` 永远为 `undefined` → 判断条件永远失败
2. 代码总是走到 `sessions.reset({ key, reason: 'new' })` → **对话被重置**
3. 重置后的 verify resolve 同样解析失败 → `mainSessionEnsured` 无法变为 `true`
4. 每次 WebSocket 重连，函数再次执行 → **再次重置对话**

### 插件测试中的盲区

测试只覆盖了 "session 不存在 → 创建" 的路径（第一次 resolve 直接 mock 返回 `ok: false`），没有测试 "session 已存在 → 跳过" 的路径，因此没有暴露此 bug。

## 修复方向（待实施）

### 方案 A：简化判断逻辑

`sessions.resolve` 返回 `ok: true` 即表示该 sessionKey 存在，无需提取 `sessionId`：

```javascript
const resolved = await gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
if (resolved?.ok === true) {
  mainSessionEnsured = true;
  return { ok: true, state: 'ready' };
}
```

重置后也只需检查 `reset.ok === true`，不必再做二次 verify：

```javascript
const reset = await gatewayRpc('sessions.reset', { key, reason: 'new' }, { timeoutMs: 2500 });
if (reset?.ok === true) {
  mainSessionEnsured = true;
  return { ok: true, state: 'created' };
}
```

### 方案 B：如需获取 sessionId 用于日志

从 `sessions.reset` 的响应中读取（这个 API 确实返回 `entry`）：

```javascript
const newSessionId = reset?.response?.payload?.entry?.sessionId;
```

### 测试补充

- 增加 "session 已存在（resolve 返回 ok: true）→ 不触发 reset" 的测试路径
- Mock 数据应与 OpenClaw 实际响应格式一致

## 其他注意事项

- `mainSessionEnsured` 标志在 gateway 重连时不会被重置，这个设计本身是合理的——只要进程存活期间确认过一次即可
- 但由于 bug，该标志从未被设置为 `true`，导致每次重连都重复执行
- 修复后应确保：进程存活期间只在首次连接时执行一次 ensure
