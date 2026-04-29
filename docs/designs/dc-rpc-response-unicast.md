---
status: UI Phase 1 已实施 / plugin Phase 2 待实施
owner: UI + plugin/openclaw
created: 2026-04-23
updated: 2026-04-29
---

# DC RPC 响应单播改造

## 0. 如何读本文档

本文脱离聊天上下文独立可读。分三大部分：

- **事实清单**（§2）：已核实的协议/代码事实，每条给锚点。
- **方案**（§3-§5）：基于事实得出的设计与改动清单。
- **兼容、测试、非目标**（§6-§8）：发布策略、验收要点、本次不做的事。

## 1. 背景与问题

### 1.1 现状

UI 通过 WebRTC rpc DataChannel 向 `@coclaw/openclaw-coclaw` 插件发送 JSON-RPC
请求。插件根据 method 分流：

- `coclaw.files.*`（本地处理）：响应**只单播回发起方**（已正确）。
- 其他方法（绝大多数）：插件把请求原样转给 OpenClaw gateway，gateway 响应回来
  后，插件**广播给所有连着的 UI PC**。

### 1.2 问题

在同一插件下有多个 UI PC（多个 tab、手机和网页并存等）时：

1. UI A 发起的请求，响应会同时到达 B、C、D。虽然 UI 的 pending 表按 id 匹配查不到
   会被丢弃，但**带宽浪费**明显——尤其是响应 payload 较大时。
2. 如果将来有"UI 共享 tab 视图"之类的功能，这个行为会成为正确性隐患。

### 1.3 目标

让"经 gateway 转发"路径上的 RPC 响应也只回给发起方。

### 1.4 非目标（本方案不做）

- **agent 事件定向**：agent run 过程中 gateway 广播的 `chat` / `agent` streaming 事
  件仍保持广播。该能力理论可行（借助事件 payload 中的 `runId`），但本方案不涉及，后
  续若有需求单独方案。
- **插件自发事件**（`broadcastPluginEvent` 推送的 `coclaw.info.updated` 等）：本质就
  是广播语义，不改。
- **异常响应广播**：插件在 gateway 离线 / 发送失败时构造的 `GATEWAY_OFFLINE` /
  `GATEWAY_SEND_FAILED` 属于系统状态公告，继续广播。

## 2. 事实清单

所有条目均经源码核实，锚点用"文件:行号"形式。

### 2.1 OpenClaw 对 `req.id` 的协议约束

来源：`openclaw-repo/src/gateway/protocol/schema/frames.ts:139-147`（RequestFrameSchema）
和 `openclaw-repo/src/gateway/protocol/schema/primitives.ts:12`（NonEmptyString）。

- 必须是 **非空字符串**（`minLength: 1`）。
- **没有** `maxLength`，**没有** 字符集 / 正则约束。
- 响应帧的 `id` **原样 echo**，不做 trim / 大小写 / 规范化
  （`message-handler.ts:1452-1458` 的 `respond` 闭包固定用 `id: req.id`）。
- 服务端**不做去重**，无全局唯一性要求。
- gateway 自身作为 client 发送 req 时用 `randomUUID()`（`gateway/client.ts:919`）。
- 日志展示层 `shortId()` 对 UUID 格式折叠为 `首8…末4`，对非 UUID 且长度 >24 的折叠为
  `首12…末4`（`ws-log.ts:93-101`）——纯显示，不影响功能。

**结论**：UUID 或 UUID + 任意后缀长度完全安全。

### 2.2 UI 端当前的 id 生成

`ui/src/services/claw-connection.js:44-45, 166`：

```js
this.__counter = 1;
// ...
const id = `ui-${Date.now()}-${this.__counter++}`;
```

- 格式 `ui-<毫秒时间戳>-<连接内自增>`。
- 计数器是 **per-ClawConnection 实例**，每个 tab 独立从 1 开始。
- 多个 tab 同时发送第一条请求时，时间戳 + counter 可能完全相同 → 跨连接 id 碰撞。
- 单个 UI 内 `__pending` Map 按 id 匹配查不到会被丢弃
  （`claw-connection.js:250-296`），所以碰撞不会造成自己端的错乱，只会让
  "插件按 id 定向"错投。

### 2.3 插件端 RPC 处理路径

| 路径 | 位置 | 当前行为 |
|------|------|---------|
| 入站 req 分流 | `webrtc-peer.js:518-532` | `coclaw.files.*` 走 `__onFileRpc`；其余走 `__onRequest` |
| `__onRequest` 回调声明 | `realtime-bridge.js:251-254` | `(dcPayload) => ...` **只接 payload，connId 丢失** |
| 转发至 gateway | `realtime-bridge.js:877-882` | `gatewayWs.send({ type:'req', id:payload.id, method, params })` |
| gatewayWs res/event 分发 | `realtime-bridge.js:740-765` | `gatewayPendingRequests` 命中则 settle；否则 `webrtcPeer.broadcast(payload)` |
| 异常响应（离线） | `realtime-bridge.js:864-872` | `webrtcPeer.broadcast({ type:'res', id, ok:false, error:GATEWAY_OFFLINE })` |
| 异常响应（发送失败） | `realtime-bridge.js:885-893` | `webrtcPeer.broadcast({ ... GATEWAY_SEND_FAILED })` |

### 2.4 单播能力已就位

`src/webrtc/webrtc-peer.js:134-146` 的 `sendTo(connId, payload)` 是现成的单播 API，
文件 DC 路径的 `sendFn` 与 `__sendPeerTransport` 均在使用。

### 2.5 两阶段 agent RPC

- 第一阶段 res：`ok: true, payload: { status: 'accepted', runId, sessionKey }`。
- 第二阶段 res：`ok: true, payload: { status: 'ok', result: ... }` 或 `ok: false, error: ...`。
- 两次响应**同一 id**，都是 `type:'res'` 帧。
- UI 侧 `__pending` 看到 `accepted` 不删，看到终态才删（`claw-connection.js:250-296`）。
- 插件侧本次改造维护的映射表也应遵循同样规则：`accepted` 保留，终态清除。

### 2.6 插件自发 RPC 与 UI 转发 RPC 的隔离

- 插件自发 RPC（`__gatewayRpc` / `__gatewayAgentRpc`）使用 `coclaw-gw-*` /
  `coclaw-agent-*` 前缀的 id（`realtime-bridge.js:281-283, 294, 347`）。
- 响应回来时先查 `gatewayPendingRequests`，命中即 settle 并 return
  （`realtime-bridge.js:740-749`），根本不会走到广播/定向分支。
- 因此新增映射表与 `gatewayPendingRequests` 天然隔离，无需前缀判重。

### 2.7 UI 端 connId 稳定性

来自 `webrtc-peer.js:148-149`：`connId = msg.fromConnId`，由 UI 侧生成，贯穿整个 PC
生命周期（含 ICE restart）。是插件侧对 UI 端的稳定标识。

## 3. 方案概要

两端改动分开发布：

1. **先升 UI**（Phase 1）：把 RPC id 换成 UUID + 递增序号，保证跨连接唯一。
2. **再升插件**（Phase 2）：入站时记录 `reqId → connId`，响应回来时按 id 定向；
   查不到则回退到广播（兼容旧 UI + 各种边缘情况）。

"先 UI 后插件" 的理由：

- 新 UI 连旧插件：id 格式变了但旧插件只是 `echo + broadcast`，不解析 id 内容，完全
  兼容。
- 旧 UI 连新插件：新插件对 id 不作强制格式校验，查 `reqId → connId` 时可能因
  cross-tab 碰撞错投——但这正是当前就存在的问题，不会**变得**更糟；同时新插件的兜
  底广播分支保证响应至少不会完全丢。

## 4. UI 端改动

### 4.1 id 生成规则

文件：`ui/src/services/claw-connection.js`

- 旧格式：`ui-${Date.now()}-${counter}`（counter 是 `this.__counter++`）
- 新格式：`ui-${uuid}-${counter}`
  - `ui-` 前缀保留：与插件自发 RPC 的前缀（`coclaw-gw-*` / `coclaw-agent-*`，
    事实 §2.6）形成统一命名约定，跨端日志可一眼识别请求来源。
  - `uuid`：`crypto.randomUUID()`，每个 ClawConnection 实例**构造时生成一次**保存到
    `this.__uuid`，后续该连接的所有请求复用，保证跨连接 reqId 唯一。
  - `counter`：**沿用现有的 `this.__counter`**，逻辑不变；调试时仍可通过 counter
    识别同一连接内的请求顺序。
- 分隔符用 `-`。

示例：`ui-550e8400-e29b-41d4-a716-446655440000-7`。

依赖说明：项目其他模块（`signaling-connection.js` 的 connId、`chat.store.js` 的
idempotencyKey、`file-transfer.js` 等）已普遍使用 `crypto.randomUUID()`，无需引入
`uuid` 依赖、也无需写 fallback——若浏览器不支持该 API，连 connId 都生成不出来，
RPC 这一层做兼容是无意义的。

实际改动：constructor 里加一行 `this.__uuid = crypto.randomUUID()`，`doSend` 里这
一行改前缀。不动 counter、不动 `__pending` 结构、不动两阶段响应识别。

### 4.2 不动的部分

- `__pending` Map 的 key 仍是完整 id；由于格式变了但仍然是字符串，无需改动。
- 两阶段响应处理、超时处理、`onAccepted` 回调均不改。

### 4.3 测试

- 新增单测覆盖：
  - 同一 ClawConnection 实例内生成的 id **带相同 uuid 前缀**、**counter 单调递增**。
  - 两个 ClawConnection 实例生成的 uuid 前缀**不同**。
  - id 符合 `<uuid>-<number>` 正则。
- 回归现有 pending / 超时 / 两阶段响应用例。

## 5. 插件端改动

### 5.1 数据结构

`RealtimeBridge` 新增字段：

```js
this.__dcPendingRequests = new Map();  // reqId -> connId
```

独立于 `gatewayPendingRequests`。无需加锁（事件循环单线程，读写同步）。

### 5.2 回调签名变更

`realtime-bridge.js:251-254`：

```js
onRequest: (dcPayload, connId) => {
    this.__handleGatewayRequestFromDc(dcPayload, connId)
        .catch((err) => this.logger.warn?.(`[coclaw] dc request handler error: ${err?.message}`));
},
```

`webrtc-peer.js:531` 已经传了 `connId`，无需改动调用侧。

### 5.3 入站记录

`__handleGatewayRequestFromDc(payload, connId)` 在向 gateway 发送前：

```js
if (connId && typeof payload.id === 'string') {
    this.__dcPendingRequests.set(payload.id, connId);
}
```

`connId` 为假值时（防御，理论上不会发生）不记录，退化为旧行为（广播兜底）。

### 5.4 响应定向

`ws message` 处理分支（`realtime-bridge.js:755-765`）改为：

```js
if (payload.type === 'res' || payload.type === 'event') {
    if (payload.type === 'event'
        && (payload.event === 'health' || payload.event === 'tick')) {
        return;
    }
    if (payload.type === 'res' && typeof payload.id === 'string'
        && this.__dcPendingRequests.has(payload.id)) {
        const connId = this.__dcPendingRequests.get(payload.id);
        const isAccepted = payload.ok === true
            && payload.payload
            && payload.payload.status === 'accepted';
        if (!isAccepted) {
            this.__dcPendingRequests.delete(payload.id);
        }
        const delivered = this.webrtcPeer?.sendTo(connId, payload);
        if (!delivered) {
            // PC 已断开或 DC 未就绪：响应丢弃，仅日志
            this.__logDebug(`dc res undeliverable: id=${payload.id} connId=${connId}`);
        }
        return;
    }
    // 非 res（即 event）或映射未命中：保持广播
    this.webrtcPeer?.broadcast(payload);
}
```

关键点：

1. **event 仍走广播**（非目标 §1.4）。
2. **accepted 保留映射**，等终态来。
3. **映射未命中退回广播**：兼容旧 UI + 跨 tab 碰撞 + 映射过期 + 任何未预期情况。
4. **PC 断开时响应丢弃**：UI 端的 `__pending` 已随 PC 销毁而不再存在，无处可送。

### 5.5 异常响应保持广播

`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 两处（`realtime-bridge.js:864, 885`）**不动**——它们是系统状态广播。

但**映射要清**（避免泄漏）：

- `GATEWAY_OFFLINE` 在 `__handleGatewayRequestFromDc` 判定 gateway 未就绪时触发，此时还没往 gateway 发请求，也就**还没往 `__dcPendingRequests` 写**（§5.3 在构造离线响应之后），实际不需要清理——但为避免代码顺序调整踩坑，**把 §5.3 的 set 放在 "gateway ready 判定之后、send 之前"**。
- `GATEWAY_SEND_FAILED` 是在 `gatewayWs.send` 抛异常后触发，此时已写入 `__dcPendingRequests`，**需要在 catch 分支删除映射**。

示意：

```js
async __handleGatewayRequestFromDc(payload, connId) {
    const ready = await this.__waitGatewayReady();
    if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
        this.webrtcPeer?.broadcast({ type:'res', id:payload.id, ok:false,
            error:{ code:'GATEWAY_OFFLINE', message:'Gateway is offline' } });
        return;
    }
    if (connId && typeof payload.id === 'string') {
        this.__dcPendingRequests.set(payload.id, connId);
    }
    try {
        this.gatewayWs.send(JSON.stringify({
            type:'req', id:payload.id, method:payload.method, params:payload.params ?? {}
        }));
    } catch {
        this.__dcPendingRequests.delete(payload.id);
        this.webrtcPeer?.broadcast({ type:'res', id:payload.id, ok:false,
            error:{ code:'GATEWAY_SEND_FAILED', message:'Failed to send request to gateway' } });
    }
}
```

### 5.6 PC 断开时的映射清理

`WebRtcPeer.closeByConnId(connId)` 会销毁 session。插件侧需要在 session 关闭时清掉属
于该 connId 的 pending 映射。

**方案**：给 `WebRtcPeer` 构造参数加一个 `onSessionClose(connId)` 回调，在
`closeByConnId` 的末尾（session 从 `__sessions` 删除后）触发。`realtime-bridge.js`
注入：

```js
onSessionClose: (connId) => {
    for (const [reqId, owner] of this.__dcPendingRequests) {
        if (owner === connId) this.__dcPendingRequests.delete(reqId);
    }
},
```

悬挂请求的响应回来后会走"映射未命中退回广播"分支——所有 PC（包括已不存在的 connId）
都收不到（UI 端 pending 已 GC），等同无害丢弃。

### 5.7 gatewayWs 断开时的映射清理

`ws close` 分支（`realtime-bridge.js:783-787`）已经清理了 `gatewayPendingRequests`，顺
便把 `__dcPendingRequests` 一起清掉——此时所有悬挂的 UI 请求都永远等不到响应，提早
释放避免内存泄漏。（UI 端自己的超时会兜底报错。）

### 5.8 测试

- 单测：
  - 单 PC 下，req → 入表 → res 命中 → sendTo 调用、广播未调用、映射被清。
  - 两阶段 agent RPC：第一阶段 accepted 不清映射，第二阶段清。
  - 映射未命中时回退到广播。
  - PC 断开时相关映射被清。
  - gatewayWs 断开时映射被清。
  - 入站 req 时 connId 为假值（防御路径）——退化为广播兜底行为。
- 回归：现有 `coclaw.files.*` 单播路径、插件自发 RPC 路径均无行为变化。

## 6. 兼容矩阵

| UI | 插件 | 行为 |
|----|------|------|
| 旧 | 旧 | 全广播（现状） |
| 新 | 旧 | 全广播（旧插件不解析 id 格式，完全兼容） |
| 旧 | 新 | 按 id 定向；跨 tab 碰撞时可能错投，但问题不比现状更严重，且兜底广播保证不丢 |
| 新 | 新 | 按 id 定向，正确单播 |

新 UI 发布后、到新插件发布前这段时间，用户看不到行为差异（都走旧路径）。插件发布后
自动进入新路径。

## 7. 非目标确认

以下内容**不在本方案**内：

- **agent 事件定向**：`chat` / `agent` streaming 事件继续广播。
- **插件自发事件定向**：`broadcastPluginEvent` 继续广播。
- **异常响应定向**：`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 继续广播。
- **UI 端 id 格式的进一步限制**：不要求 UI 必须使用 UUID 格式，插件侧仍按字符串对待。

## 8. 发布与回滚

### 8.1 发布顺序

1. UI 侧 PR（id 生成规则），发布、自动升级。
2. 插件侧 PR（定向 + 兜底广播），独立 changeset，发布到 npm。

### 8.2 回滚

- UI 回滚：revert id 生成规则，无协议层影响。
- 插件回滚：revert 定向逻辑，回到全广播。不需要跨端协调。

### 8.3 灰度

- 插件侧的改动保留"兜底广播"分支，本身自带灰度降级能力——映射表异常时自动退化到旧
  行为。
- 不需要额外 feature flag。

## 9. 关键文件索引

### UI 侧

| 路径 | 内容 |
|------|------|
| `ui/src/services/claw-connection.js:44-48, 177` | id 生成与 `__pending` Map（含 `__uuid` 前缀） |
| `ui/src/services/claw-connection.js:261-308` | `__handleRpcResponse`（两阶段响应识别） |

### 插件侧

| 路径 | 内容 |
|------|------|
| `plugins/openclaw/src/realtime-bridge.js:249-265` | WebRtcPeer 构造参数注入点 |
| `plugins/openclaw/src/realtime-bridge.js:740-765` | ws message res/event 分发 |
| `plugins/openclaw/src/realtime-bridge.js:860-895` | `__handleGatewayRequestFromDc` |
| `plugins/openclaw/src/webrtc/webrtc-peer.js:112-146` | `broadcast` / `sendTo` |
| `plugins/openclaw/src/webrtc/webrtc-peer.js:518-532` | 入站 req 分流（含 connId 传递） |
| `plugins/openclaw/src/webrtc/webrtc-peer.js:64-102` | `closeByConnId`（注入 onSessionClose 的位置） |

### 相关调研

- `docs/study/plugin-rpc-event-routing-research.md`：本方案的前置调研。
