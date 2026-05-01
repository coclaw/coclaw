---
status: UI Phase 1 已实施 / plugin Phase 2 方案已细化、待实施
owner: UI + plugin/openclaw
created: 2026-04-23
updated: 2026-05-01
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
- **gateway ws 断开主动通知 UI**：clear 表后让 UI 自行超时。
- **PC 断开主动清映射**：正常响应快速到达自然清理；长程 RPC 残留由 24h TTL 兜底。
- **per-connId 条目上限**：暂不引入。24h TTL 已是上限。
- **`coclaw-*` 前缀的 reqId 防御**：UI 即使误用插件自发 RPC 命名空间也只会占新表条目，
  不会污染 `gatewayPendingRequests`（两表写入路径不同）。本方案不加防御。

## 2. 事实清单

所有条目均经源码核实，锚点用"文件:行号"形式。

### 2.1 OpenClaw 对 `req.id` 的协议约束

来源：`openclaw-repo/src/gateway/protocol/schema/frames.ts:139-147`（RequestFrameSchema）
和 `openclaw-repo/src/gateway/protocol/schema/primitives.ts:12`（NonEmptyString）。

- 必须是 **非空字符串**（`minLength: 1`）。
- **没有** `maxLength`，**没有** 字符集 / 正则约束。
- 响应帧的 `id` **原样 echo**，不做 trim / 大小写 / 规范化
  （`message-handler.ts:1531-1574` 的 `respond` 闭包固定用 `id: req.id`）。
- 服务端**不做去重**，无全局唯一性要求。
- gateway 自身作为 client 发送 req 时用 `randomUUID()`（`gateway/client.ts:919`）。

**结论**：UUID 或 UUID + 任意后缀长度完全安全。

### 2.2 UI 端当前的 id 生成（已实施）

`ui/src/services/claw-connection.js:55-59, 191`（commit `f8f83f0`）：

```js
this.__counter = 1;
this.__uuid = crypto.randomUUID();
// ...
const id = `ui-${this.__uuid}-${this.__counter++}`;
```

- 格式 `ui-<uuid>-<连接内自增>`。
- UUID 在 ClawConnection 构造时生成一次复用，**跨连接 reqId 必然唯一**。
- 同 UI 内 `__pending` Map 按 id 匹配；查不到丢弃（`claw-connection.js:261-308` 左右）。

### 2.3 插件端 RPC 处理路径（当前真实状态，2026-05-01）

| 路径 | 位置 | 当前行为 |
|------|------|---------|
| 入站 req 分流 | `webrtc-peer.js:518-540` | `coclaw.files.*` 走 `__onFileRpc(payload, sendFn, connId)` 单播；其余走 `__onRequest?.(payload, connId)`，**connId 已传**但 bridge 端未接 |
| `__onRequest` 回调声明 | `realtime-bridge.js:276-279` | `(dcPayload) => ...` **只接 payload，connId 丢失**（待改） |
| 转发至 gateway | `realtime-bridge.js:909-915` | `gatewayWs.send({ type:'req', id:payload.id, method, params })` |
| gatewayWs res/event 分发 | `realtime-bridge.js:765-795` | (1) `gatewayPendingRequests` 命中即 settle return；(2) filter `event:health/tick`；(3) 调 `classifyAgentLagStop` 停 lag 探针；(4) `webrtcPeer?.broadcast(payload)` |
| 异常响应（离线） | `realtime-bridge.js:894-906` | `webrtcPeer.broadcast({ ... GATEWAY_OFFLINE })` |
| 异常响应（发送失败） | `realtime-bridge.js:921-931` | `webrtcPeer.broadcast({ ... GATEWAY_SEND_FAILED })` |

### 2.4 单播能力已就位

`src/webrtc/webrtc-peer.js:137-151` 的 `sendTo(connId, payload)` 是现成的单播 API，
返回 boolean（false=session 不存在 / DC 未 open / payload 不可序列化 / 队列拒收）。
文件 DC 路径的 `sendFn`、`__sendPeerTransport` 均已使用。`coclaw.files.*` 的入站
分流（`webrtc-peer.js:524-538`）就是天然单播范例。

### 2.5 两阶段 agent RPC

- 第一阶段 res：`{ ok: true, payload: { status: 'accepted', runId, sessionKey } }`。
- 第二阶段 res：`{ ok: true, payload: { status: 'ok', result: ... } }` 或 `{ ok: false, error: ... }`。
- 两次响应**同一 id**，都是 `type:'res'` 帧。
- UI 侧 `__pending` 看到 `accepted` 不删，看到终态才删（`claw-connection.js:261-308` 左右）。
- 插件侧本次改造维护的映射表也应遵循同样规则：`accepted` 保留，终态清除。

### 2.6 插件自发 RPC 与 UI 转发 RPC 的隔离

- 插件自发 RPC（`__gatewayRpc` / `__gatewayAgentRpc`）使用 `coclaw-gw-` /
  `coclaw-agent-` / `coclaw-connect-` / `coclaw-rpc-` 前缀的 id（`realtime-bridge.js:306-319, 372, 609`）。
- 响应回来时**先**查 `gatewayPendingRequests`，命中即 settle 并 return
  （`realtime-bridge.js:765-775`），根本不会走到广播 / 定向分支。
- 因此新增映射表与 `gatewayPendingRequests` **天然隔离**：写入路径不同（plugin 自发
  写 `gatewayPendingRequests`、UI 转发写 `__dcPendingRequests`），UI 即使误用
  `coclaw-*` 前缀也只占新表条目，无法跨表污染。

### 2.7 UI 端 connId 稳定性

来自 `webrtc-peer.js:148-149`：`connId = msg.fromConnId`，由 UI 侧生成，贯穿整个 PC
生命周期（含 ICE restart）。是插件侧对 UI 端的稳定标识。

### 2.8 OpenClaw 上游"终态 res"判定

独立 opus + codex-rescue 双路调研一致结论（2026-05-01）：

- **协议 schema 层无形式化区分**：`ResponseFrameSchema` 中 `payload` 是
  `Type.Unknown()`，不约束 status 字段
  （`openclaw-repo/src/gateway/protocol/schema/frames.ts:147-156`）。
- **唯一权威判据**：上游 client 自身用 `pending.expectFinal && status === "accepted"`
  判中间态，其余皆终态（`openclaw-repo/src/gateway/client.ts:837-843`）。
- **目前会发中间态 res 的方法仅 3 个**：
  - `agent`（`server-methods/agent.ts:1103-1224`）
  - `exec.approval.request`（twoPhase=true 时；`server-methods/exec-approval.ts:144-287` + `approval-shared.ts:233-265`）
  - `plugin.approval.request`（同上；`server-methods/plugin-approval.ts:71-129`）
- **唯一已知中间态字符串**：`"accepted"`。其他 status 值（`"ok"`、`"error"`、
  `"timeout"`、`"started"`、`"in_flight"`）均为终态。
- **关键反例**：`chat.send` 终态 payload 是 `{ status: "started" }`（单帧立即终态；
  `server-methods/chat.ts:2059-2063`），故**不能**用"已知终态字符串黑名单"判据，会
  卡死 `chat.send`。
- **稳健性**：白名单已知中间态（即 `status !== "accepted"`）与上游 client 自身判据严
  格同构；即使上游未来引入新中间态字符串而 CoClaw 未及时同步，残留路径会退化为兜底广
  播，不丢响应。

### 2.9 插件 lag 探针耦合

`classifyAgentLagStop`（`realtime-bridge.js:48-53`）当前在 ws message res 分发分支前
置位置（`realtime-bridge.js:790-793`）调用，决定 agent run 进 phase-2 终态时停 lag
探针。本方案改造**必须保留这个位置**——把 `__stopLagProbe` 调用置于新增的 sendTo
单播分支之前，避免单播分支命中后探针不停（导致 60s 兜底 + 噪声日志）。

`classifyAgentLagStop` 是 lag 探针的局部判据（返回原因字符串供日志），**不复用**到
路由表清条目逻辑。路由表使用独立的 `isFinalResMsg`（§5.1）。

## 3. 方案概要

两端改动分开发布：

1. **先升 UI**（Phase 1，已实施 commit `f8f83f0`）：把 RPC id 换成
   `ui-<uuid>-<counter>`，保证跨连接唯一。
2. **再升插件**（Phase 2，本方案落地范围）：入站时记录
   `reqId → { connId, expireAt }`，响应回来时按 `isFinalResMsg` 终态判定决定清映射并
   按 connId 单播；查不到则回退到广播（兼容旧 UI + 各种边缘情况）。

**关键决策清单**（详见各小节）：

- `isFinalResMsg` 终态判据与 OpenClaw 上游 `client.ts` 严格镜像（§2.8、§5.1）
- `classifyAgentLagStop` 不复用，仅服务 lag 探针（§5.1、§2.9）
- 撞号 → 删原映射，让响应走广播兜底（§5.4）
- DC 已关时丢弃，**不退回广播**（§5.5）
- 异常响应保留广播（§5.6）
- PC 断开**不动映射**，由 TTL + sendTo 容错兜底（§5.7）
- gateway 断开 `clear` 整表，**不主动通知 UI**（§5.8）
- 整表 1h 周期扫描清 24h 过期条目，**不为每条挂 timer**（§5.9）

"先 UI 后插件"的理由：

- 新 UI 连旧插件：id 格式变了但旧插件只是 echo + broadcast，不解析 id 内容，完全
  兼容。
- 旧 UI 连新插件：新插件对 id 不作强制格式校验，查 `__dcPendingRequests` 时可能因
  cross-tab 碰撞错投——但兜底广播保证不丢；新插件本身也保留兜底分支。

## 4. UI 端改动（已实施）

### 4.1 id 生成规则

文件：`ui/src/services/claw-connection.js`

- 旧格式：`ui-${Date.now()}-${counter}`
- 新格式：`ui-${uuid}-${counter}`
  - `ui-` 前缀保留：与插件自发 RPC 的前缀（`coclaw-gw-*` / `coclaw-agent-*`，
    事实 §2.6）形成统一命名约定，跨端日志可一眼识别请求来源。
  - `uuid`：`crypto.randomUUID()`，每个 ClawConnection 实例**构造时生成一次**保存到
    `this.__uuid`，后续该连接的所有请求复用，保证跨连接 reqId 唯一。
  - `counter`：**沿用现有的 `this.__counter`**，逻辑不变。

示例：`ui-550e8400-e29b-41d4-a716-446655440000-7`。

### 4.2 不动的部分

- `__pending` Map 的 key 仍是完整 id；由于格式变了但仍然是字符串，无需改动。
- 两阶段响应处理、超时处理、`onAccepted` 回调均不改。

### 4.3 已部署

commit `f8f83f0 feat(ui): make DC RPC reqId unique across ClawConnection instances via uuid`。

## 5. 插件端改动

### 5.1 终态判定函数（新增独立工具）

文件：`plugins/openclaw/src/realtime-bridge.js`，紧挨现有 `classifyAgentLagStop`
（line 48-53）下方放置并 `export`；命名与 OpenClaw 上游 `expectFinal` 概念对齐。

```js
/**
 * 判断一个 res 帧是否为终态（不会再有后续同 id 帧跟随）。
 * 与 OpenClaw 上游 client.ts:837-843 的 expectFinal+status==='accepted' 判据严格
 * 镜像：仅当内层 status==='accepted' 时视为中间态，其他一切（含无 status 字段）
 * 均为终态。详见 §2.8。
 *
 * @param {object} frame
 * @returns {boolean}
 */
export function isFinalResMsg(frame) {
    return frame?.type === 'res' && frame?.payload?.status !== 'accepted';
}
```

**判据来源**：与 OpenClaw 上游 `gateway/client.ts:837-843` 的
`expectFinal && status === "accepted"` 判据严格镜像。详见事实 §2.8。

**与 `classifyAgentLagStop` 的关系**：

- `classifyAgentLagStop` 解决 agent run lag 探针的局部问题（返回原因字符串供日志使
  用），**不复用**到路由逻辑。
- `isFinalResMsg` 解决路由表清条目的全局问题（返回 boolean）。
- 两者判据相似但语义边界不同，各自独立。

### 5.2 数据结构与常量

新常量（放在 `realtime-bridge.js` 顶部既有常量区，参考 `RECONNECT_MS` /
`SERVER_HB_PING_MS` 等）：

```js
// UI 转发 RPC 路由表条目的最大存活时间（24h）。
// 选 24h 的理由：agent run 极端可达数小时甚至更久；正常 RPC 在终态触达前
// 已自然清除；24h 足够覆盖几乎所有真实场景，且条目内存压力可忽略。
const DC_REQ_TTL_MS = 24 * 60 * 60 * 1000;
// 整表周期扫描间隔（1h）。条目存留误差 0~1h，对内存压力毫无影响。
const DC_REQ_SCAN_MS = 60 * 60 * 1000;
```

`RealtimeBridge` 构造函数中新增字段（与现有 `gatewayPendingRequests` 等字段并列
初始化，参考 `realtime-bridge.js:131` 附近）：

```js
this.__dcPendingRequests = new Map();   // reqId -> { connId, expireAt }
this.__dcPendingScanTimer = null;        // 整表周期扫描器（1h）
```

- `expireAt`：写入时设置为 `Date.now() + DC_REQ_TTL_MS`。
- **不为每条单独挂 timer** —— 整表共享一个 1h 周期扫描（详见 §5.9），避免上百条
  timer 增加调度负担。
- 独立于 `gatewayPendingRequests`，无锁（事件循环单线程，读写同步）。

### 5.3 回调签名变更

`webrtc-peer.js:540` 已经把 connId 传给 `__onRequest?.(payload, connId)`，调用侧已
就绪。bridge 端只需扩签名（`realtime-bridge.js:276-279`）：

```js
onRequest: (dcPayload, connId) => {
    this.__handleGatewayRequestFromDc(dcPayload, connId)
        .catch((err) => this.logger.warn?.(`[coclaw] dc request handler error: ${err?.message}`));
},
```

### 5.4 入站记录与撞号处理

`__handleGatewayRequestFromDc(payload, connId)` 改造后完整轮廓（保留现存 lag 探针
启动逻辑、加 connId 形参 + 写映射 + 撞号处理）：

```js
async __handleGatewayRequestFromDc(payload, connId) {
    const ready = await this.__waitGatewayReady();
    if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
        // OFFLINE 路径：此时还没写映射，广播即可（保持现状）
        this.__logDebug(`gateway req drop (offline): id=${payload.id} method=${payload.method}`);
        this.webrtcPeer?.broadcast({
            type: 'res',
            id: payload.id,
            ok: false,
            error: { code: 'GATEWAY_OFFLINE', message: 'Gateway is offline' },
        });
        return;
    }

    // 撞号检测：极小概率（UUID 全唯一），但旧版 UI cross-tab / UI bug 可能触发
    const id = payload.id;
    if (typeof id === 'string' && this.__dcPendingRequests.has(id)) {
        this.logger.warn?.(`[coclaw] duplicate dc reqId, dropping previous mapping: id=${id}`);
        this.__dcPendingRequests.delete(id);
        // 不主动回旧发起方错误响应（可能已断）；下面会写入新映射；
        // gateway 回来的两条同 id 响应：第一条单播给当前登记的发起方 + 清条目，
        // 第二条因记录已清走广播兜底（详见 §6）
    }

    // 写入映射(在 ready 判定通过之后,在 send 之前)
    if (typeof id === 'string' && connId) {
        this.__dcPendingRequests.set(id, {
            connId,
            expireAt: Date.now() + DC_REQ_TTL_MS,
        });
    }

    try {
        this.__logDebug(`gateway req -> id=${id} method=${payload.method}`);
        this.gatewayWs.send(JSON.stringify({
            type: 'req',
            id,
            method: payload.method,
            params: payload.params ?? {},
        }));
        // lag 探针(不变):仅 agent RPC 启动
        if (payload.method === 'agent') {
            this.__startLagProbe(id);
        }
    } catch {
        // SEND_FAILED 路径:已写映射 → 撤回 + 广播
        if (typeof id === 'string') {
            this.__dcPendingRequests.delete(id);
        }
        this.webrtcPeer?.broadcast({
            type: 'res',
            id,
            ok: false,
            error: { code: 'GATEWAY_SEND_FAILED', message: 'Failed to send request to gateway' },
        });
    }
}
```

要点:
- **写映射的时序窗口**:必须在 `__waitGatewayReady` 判定通过 **之后** 写,在 `send`
  调用 **之前** 写;两端窗口都已用代码顺序锚定,不存在脏映射可能。
- **撞号策略 → 删旧 + 写新 + warn,不回错给旧发起方**:gateway 不去重会回两条同 id
  响应,第一条到达时单播给当前登记的发起方并清条目,第二条因记录已清走广播兜底。
  目标是"响应至少送到原 UI"——旧发起方通过广播兜底仍能收到响应,无效广播只是节流
  问题,可容忍。已知风险(发起方 settle 错条响应)在 §6 兼容矩阵备注。
- **connId 缺失时不写映射**:理论上 webrtc-peer 调用侧必传(§2.3),`if (connId)` 是
  纯防御。connId 缺失时退化为旧广播行为(由后续广播兜底分支兜)。

### 5.5 响应定向

`gatewayWs message` 处理改造点位于现存代码 `realtime-bridge.js:765-795` 范围。
保留现有的 (1) `gatewayPendingRequests` settle、(2) `health/tick` filter、(3)
`classifyAgentLagStop` 停探针 三段，**仅在最末尾的 `webrtcPeer?.broadcast(payload)`
之前** 插入新分支。改造后骨架：

```js
// 现有逻辑(line 765-775):plugin 自发 RPC settle
if (payload.type === 'res' && typeof payload.id === 'string') {
    const settle = this.gatewayPendingRequests.get(payload.id);
    if (settle) {
        settle({ ... });
        return;
    }
}

// 现有防御(line 776-779):connect 完成前的消息过滤
if (!this.gatewayReady) return;

// 改造后的分发块(替换 line 780-794):
if (payload.type === 'res' || payload.type === 'event') {
    // (a) 现有 health/tick filter,不变
    if (payload.type === 'event'
        && (payload.event === 'health' || payload.event === 'tick')) {
        return;
    }
    // (b) 现有 lag 探针停止,不变(必须在 sendTo 之前调,见 §2.9)
    const lagReason = classifyAgentLagStop(payload);
    if (lagReason !== null) {
        this.__stopLagProbe(payload.id, lagReason);
    }
    // (c) 【新增】UI 转发 RPC 的 res 单播
    if (payload.type === 'res' && typeof payload.id === 'string') {
        const info = this.__dcPendingRequests.get(payload.id);
        if (info) {
            // 终态才清条目;accepted 类中间态保留等下一帧
            if (isFinalResMsg(payload)) {
                this.__dcPendingRequests.delete(payload.id);
            }
            const delivered = this.webrtcPeer?.sendTo(info.connId, payload);
            if (!delivered) {
                // PC 已断 / DC 未 open / 队列拒收:本地 log 丢弃,不退回广播
                this.__logDebug(
                    `dc res undeliverable: id=${payload.id} connId=${info.connId}`
                );
            }
            return;
        }
    }
    // (d) 兜底广播:覆盖 event 类型 / 映射未命中(旧 UI、撞号删旧后旧响应、上游新
    //     增中间态字符串导致提前清条目等场景)
    this.webrtcPeer?.broadcast(payload);
}
```

要点:
- **终态判定用 `isFinalResMsg`** —— 内层 `payload.status !== 'accepted'` 即终态。
  accepted 留映射等下一帧。
- **lag 探针停止位置不变** —— 在新分支(c) 之前调用,确保 sendTo 命中也能正常停止
  探针。`__stopLagProbe` 内部对未注册 id 是 no-op,对单阶段 RPC 终态调用无副作用。
- **DC 已关时丢弃,不退回广播** —— 其他 UI 收到无关响应只会让接收方困惑;UI 自己有
  30/60s 超时;丢弃仅 `__logDebug`,不 remoteLog。
- **映射未命中走广播** —— 兜底分支保证旧 UI / 撞号 / 上游新增中间态字符串等场景下
  响应仍能触达 UI(退化为旧行为,不丢消息)。

### 5.6 异常响应保持广播

`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 两处保持现状广播。理由：

- OFFLINE 在写映射之前触发（gateway 未 ready），无脏映射。
- SEND_FAILED 已写映射 → catch 中 `delete` 后再广播。

虽然两条都可改为单播，但代价不对称：改造面、两端协议确认、测试覆盖都更复杂。本次保
留广播，符合"系统状态广播"语义。

### 5.7 PC 断开时不主动清映射

**重要决策**：单个 PC 断连时**不**遍历删除映射条目。理由：

- 正常 RPC 响应通常很快回来，自然清掉绝大多数条目。
- 长程 RPC（如 agent run）的死条目数量不会大（同时挂起的几个）。
- 主动清的代价：触发后续 gateway 响应"找不到映射" → 退回广播 → 反而推高广播量。
- 24h TTL 兜底已足够防泄漏。

**容错**：响应自然到来时若映射命中但 DC 已关 → `sendTo` 返回 false → 本地
`__logDebug` 丢弃即可（§5.5 已涵盖）。

### 5.8 gateway WS 断开时清空整表

ws close handler（`realtime-bridge.js:801-835`）已经清 `gatewayPendingRequests`，旁
边加 `__dcPendingRequests.clear()`。同步在 `__closeGatewayWs`
（`realtime-bridge.js:231-256`）添加同样清理。

**不主动通知 UI**：清表后 UI 端会因自己 30/60s 超时报错。原因是给所有 owner 主动
sendTo 的复杂度（多 connId 并发、错误处理、与 PC close 时序竞争）较高，而 gateway 与
插件同进程触发频率本身极低；牺牲一点 UI 等待延迟换简化是划算的。

### 5.9 TTL 周期扫描

常量 `DC_REQ_TTL_MS` / `DC_REQ_SCAN_MS` 在 §5.2 定义。

启动 bridge 时在 `start()` 中挂周期定时器（位置：现有
`realtime-bridge.js:1210-1235` 的 `start()` 方法内，在 `__connectIfNeeded()` 之前
即可）：

```js
this.__dcPendingScanTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, info] of this.__dcPendingRequests) {
        if (info.expireAt <= now) {
            this.__dcPendingRequests.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        this.logger.warn?.(`[coclaw] dc pending entries expired: count=${cleaned}`);
    }
}, DC_REQ_SCAN_MS);
this.__dcPendingScanTimer.unref?.();
```

`stop()` 中 `clearInterval(this.__dcPendingScanTimer)` 并置 null（位置：现有
`realtime-bridge.js:1259-1316` 的 `stop()` 方法，参考其他 timer 的清理顺序）。

**为何选 24h / 1h 扫描**：

- agent run 可能持续数小时（极端情况 48h），用更短 TTL 会误清正在处理的条目。
- 24h 已覆盖几乎所有真实场景；正常 RPC 在终态触达前已自然清除。
- 1h 扫描粒度足够——条目的存留误差在 0~1h 间，对内存压力毫无影响（百量级条目 × 几
  十字节 = 微不足道）。

### 5.10 测试

覆盖率门禁见 `plugins/openclaw/CLAUDE.md`：lines 100% / functions 100% /
branches 95% / statements 100%。新增分支需补够单测才能通过门禁。

bridge 单测必须覆盖：

1. 单播命中：req → 入表 → res 终态 → `sendTo` 调用、`broadcast` 未调用、映射被清。
2. 两阶段 agent：accepted 留映射 + 终态清映射。
3. 两阶段 approval（exec/plugin）：accepted 留 + 终态清（验证非 agent 也走相同
   判据）。
4. `chat.send` 单帧 `status:"started"` → 立即清（验证非黑名单语义）。
5. 单阶段 RPC（如 sessions.resolve / agents.list）：响应即清。
6. 撞号：set 同 reqId → warn + delete 原条目，后续响应走广播。
7. 网关 OFFLINE：不写映射、广播。
8. send 失败：清映射 + 广播 SEND_FAILED。
9. 网关 ws close：`__dcPendingRequests` 清空（不主动通知）。
10. PC 断开：映射不变；后续响应到来 `sendTo` 返回 false → 本地 log 丢弃。
11. 映射未命中：兜底广播。
12. TTL 周期扫描：超过 24h 的条目自动清理 + warn 日志（用注入时钟或快速 TTL 测）。

`isFinalResMsg` 单测：`accepted`、`ok`、`error`、`started`、`in_flight`、无 status
字段、非 res 帧、null、undefined 等所有形态。

`webrtc-peer.test` 不需要新增（不再注入 `onSessionClose` 回调）。

## 6. 兼容矩阵

| UI | 插件 | 行为 |
|----|------|------|
| 旧 | 旧 | 全广播（现状） |
| 新 | 旧 | 全广播（旧插件不解析 id 格式，完全兼容） |
| 旧 | 新 | 按 id 定向；跨 tab 撞号时删旧 + 写新（详见下方"撞号策略"） |
| 新 | 新 | 按 id 定向，正确单播 |

新 UI 发布后、到新插件发布前这段时间，用户看不到行为差异（都走旧路径）。插件发布后
自动进入新路径。

**撞号策略**（仅"旧 UI + 新插件"场景，新 UI 因 reqId 含 UUID 跨连接唯一不会触发）：

旧 UI 跨 tab 用同一个 reqId 时，plugin 处理是"删旧 + 写新 + warn"。gateway 不去重，
两次请求各回一条同 id 响应：

- 第一条到达时：路由表登记的是新发起方，单播给新发起方 + 清条目
- 第二条到达时：记录已清，走广播兜底——所有连着的 UI PC 都会收到

设计目标"响应至少送到原 UI"在所有路径上都成立——旧发起方通过广播兜底仍能收到响应。

**已知风险**：旧 UI 的 `__pending` 表按 id 匹配，新发起方可能**误把旧请求的响应
settle 成新请求的结果**。这是旧 UI 自身的存量问题（在没有本方案前也存在，因为单 id
原本就会撞），新插件不让它变得更糟。无效广播只是节流问题，可容忍。

## 7. 非目标确认

以下内容**不在本方案**内：

- **agent 事件定向**：`chat` / `agent` streaming 事件继续广播。后续可考虑借助事件
  payload 中的 `runId` 单独定向。
- **插件自发事件定向**：`broadcastPluginEvent` 继续广播。
- **异常响应定向**：`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 继续广播。
- **gateway ws 断开主动通知 UI**：clear 表后让 UI 自行超时。
- **PC 断开主动清映射**：正常响应快速到达自然清理；长程 RPC 残留 24h TTL 兜底。
- **per-connId 条目上限**：暂不引入。
- **`coclaw-*` 前缀的 reqId 防御**：UI 即使误用插件自发 RPC 命名空间也只会占新表条
  目，不会污染 `gatewayPendingRequests`（写入路径不同）。
- **UI 端 id 格式的进一步限制**：协议层不要求 UUID 格式，插件侧仍按字符串对待。

## 8. 发布与回滚

### 8.1 发布顺序

1. UI 侧 PR（id 生成规则），发布、自动升级。**已完成**（commit `f8f83f0`）。
2. 插件侧 PR（定向 + TTL + 兜底广播），独立 changeset，发布到 npm。

### 8.2 回滚

- UI 回滚：revert id 生成规则，无协议层影响。
- 插件回滚：revert 定向逻辑，回到全广播。不需要跨端协调。

### 8.3 灰度

- 插件侧的改动保留"兜底广播"分支，本身自带灰度降级能力——映射表异常 / 未命中时自
  动退化到旧行为。
- 不需要额外 feature flag。
- changeset 类型：minor（新增行为，不破坏接口）。

## 9. 关键文件索引

### UI 侧（已实施）

| 路径 | 内容 |
|------|------|
| `ui/src/services/claw-connection.js:55-59, 191` | 构造时生成 `__uuid`，用于 reqId 拼装 |
| `ui/src/services/claw-connection.js:261-308`（左右） | `__handleRpcResponse` 两阶段响应识别 |

### 插件侧（待实施）

| 路径 | 内容 |
|------|------|
| `plugins/openclaw/src/realtime-bridge.js:48-53` | `classifyAgentLagStop`（不复用） |
| `plugins/openclaw/src/realtime-bridge.js:276-279` | `onRequest` 回调声明（需扩 connId 形参） |
| `plugins/openclaw/src/realtime-bridge.js:765-795` | ws message 分发分支（核心改造点） |
| `plugins/openclaw/src/realtime-bridge.js:893-932` | `__handleGatewayRequestFromDc`（核心改造点） |
| `plugins/openclaw/src/realtime-bridge.js:231-256` | `__closeGatewayWs`（增 `__dcPendingRequests.clear()`） |
| `plugins/openclaw/src/realtime-bridge.js:801-835` | gateway ws close handler（增 `__dcPendingRequests.clear()`） |
| `plugins/openclaw/src/realtime-bridge.js:1210-1235` | `start()`（启动周期扫描） |
| `plugins/openclaw/src/realtime-bridge.js:1259-1316` | `stop()`（清理周期扫描） |
| `plugins/openclaw/src/webrtc/webrtc-peer.js:111-151` | `broadcast` / `sendTo` |
| `plugins/openclaw/src/webrtc/webrtc-peer.js:518-540` | 入站 req 分流（已传 connId，无需改） |

### 相关调研

- `docs/study/plugin-rpc-event-routing-research.md`：本方案的前置调研。
