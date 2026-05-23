# Plugin 自发事件

> 给未来的 agent：plugin 主动向 server / UI 广播事件的清单和约定。
> 与"OpenClaw gateway 的事件流"是两回事——后者是 OpenClaw 内置 lifecycle:* / agent:* 等事件，
> 本插件只是顺带转发；本 doc 讲的是**plugin 自己产生的事件**，如改名后告诉 server 和 UI 同步。

## 入口与广播路径

`broadcastPluginEvent(event, payload)`（`realtime-bridge.js`）。一次调用同时做两件事：

```
broadcastPluginEvent(event, payload)
  ├─ singleton.__forwardToServer({ type:'event', event, payload })   ← server WS 推送
  └─ singleton.webrtcPeer?.broadcast({ type:'event', event, payload }) ← 所有 connected rpc DC
```

帧格式与 gateway 事件一致（`{ type:'event', event, payload }`），便于 server / UI 复用同一套消息分发逻辑。

bridge 未启动（singleton 为 null）时 silently no-op——register 阶段就调到 broadcastPluginEvent 不会崩。

## 事件清单

| 事件名 | 触发时机 | payload 字段 |
|---|---|---|
| `coclaw.info.updated` | <ul><li>gateway connect 成功后由 `__pushInstanceInfo()` 调一次（全量 4 字段）</li><li>外线 server WS open 时若内线 `gatewayReady` 已 true 也补推一次（三线独立后内线可能先于外线就绪，第一次 push 在 server 路径被 drop）</li><li>`coclaw.info.patch` handler 改名成功后（仅 name + hostName）</li></ul> | `name?: string \| null` <br> `hostName?: string` <br> `pluginVersion?: string` <br> `agentModels?: Array<{id, name, model}> \| null` |

新增事件时在这张表里加一行 + 在 `realtime-bridge.js` 顶部 export `broadcastPluginEvent` 调用点列出来。

## Patch 语义（重要）

**`coclaw.info.updated` 的 payload 按 patch 语义处理**——只更新 payload 中实际出现的字段（`Object.hasOwn` 判定），缺失字段保留原值。

### 为什么必须这样

- Plugin 端 `coclaw.info.patch` handler 只发 `{ name, hostName }`（用户改名场景）。
- 若 server 把缺失的 `pluginVersion` / `agentModels` 当 null 处理，admin 仪表盘里这两列会被错误清空。
- Plugin 启动时 `__pushInstanceInfo()` 发全量字段把状态铺平；之后的增量推送只发变化的字段。
- `agentModels` 采集失败时 plugin **漏报字段而非发显式 null**——后者会触发上述清空（OpenClaw manifest cache 偶发卡顿场景实测有撞过）。schema 中保留 `| null` 仅为协议层向后兼容。

### Server 端实现要求

读到 `coclaw.info.updated` 时：

```js
// pseudo
for (const key of Object.keys(payload)) {
  if (Object.hasOwn(payload, key)) {
    db.set(key, payload[key]);    // 更新出现的字段（含显式 null）
  }
  // 缺失的字段：什么都不做
}
```

**禁止 missing-as-null 处理**——这是约定，不是建议。

### UI 端实现要求

UI 通过 DC 直接收到事件，更新 `pluginInfo.*` 的对应字段。同样按 patch 语义，缺失字段保留旧值。

server 收到 `coclaw.info.updated` 后**不转发给 UI WS**——UI 走 DC 直收，避免双发。

## 设计决策记录

### 为什么 plugin 自发事件不走 OpenClaw gateway 事件流

OpenClaw 的 gateway 事件流（`lifecycle:*` / `agent:*` 等）是 OpenClaw 内核自己的事件，外部插件没有"在内核事件总线上注入新事件"的入口。所以 plugin 自发事件必须走自己的广播路径。

副效果是：plugin 可以决定哪些事件要广播给谁——比如 `coclaw.info.updated` 同时给 server 和 UI，未来如果有"只给 server"的事件也能定制。

### 为什么 server 不转发到 UI

UI 通过 rpc DC 直接收到事件，server 不需要承担转发——少一跳延迟。代价是若 DC 没建好（比如 UI 刚启动还在握手），UI 会错过这次事件。但 UI 启动时会主动发 `coclaw.info.get` 拉一次，所以不依赖事件捕获完整序列。

## 何时来读这份 doc

- 加新的 plugin 自发事件——按 `coclaw.info.updated` 的形状（patch 语义 + 双广播）抄。
- server / UI 处理 `coclaw.info.updated` 出问题——核对 patch 语义那段。
- 看到 `broadcastPluginEvent` 调用想知道为什么不走 gateway 事件流——解释在"设计决策记录"。
