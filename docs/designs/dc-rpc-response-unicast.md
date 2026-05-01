---
status: 已实施
owner: UI + plugin/openclaw
created: 2026-04-23
updated: 2026-05-01
---

# DC RPC 响应单播

## 0. 一句话概要

UI 通过 WebRTC DataChannel 给 plugin 发 JSON-RPC，plugin 转给 OpenClaw gateway。
原本 plugin 把 gateway 响应**广播**给所有连着的 UI PC；现在按 `reqId → connId` 路由
表**单播**给原发起方；查不到映射时回退广播兜底。

## 1. 背景与目标

### 1.1 现状

- `coclaw.files.*` 在 plugin 本地处理，响应只单播回发起方（已正确）
- 其他方法由 plugin 转发给 gateway，gateway 响应到 plugin 后广播给所有 UI PC

### 1.2 问题

多个 UI PC 连同一个 plugin（多 tab、手机/网页并存）时：

- 响应被发给不需要的 PC，**浪费带宽**——尤其响应 payload 较大时
- 共享 tab 视图等未来场景下，会成为正确性隐患

### 1.3 设计目标

- **核心目标**：响应至少送到原 UI（不丢响应）
- **次要目标**：尽量只送到原 UI，减少无效广播

兜底原则：**所有边缘场景下，原 UI 必须能收到响应**——要么直接单播，要么通过广播兜底
被动收到。无效广播只是节流问题，可容忍。

### 1.4 非目标（本方案不解决）

- **agent / chat 流式事件定向**：gateway 广播的 streaming 事件继续广播。后续若需定向
  应另行设计（理论可借助事件 payload 的 `runId`）
- **插件自发事件定向**：`broadcastPluginEvent` 等继续广播——本质就是广播语义
- **异常响应定向**：`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 是系统状态公告，继续广播
- **gateway WS 断开主动通知 UI**：清表后让 UI 自行 30/60s 超时
- **PC 断开主动清映射**：正常响应快速到达自然清理；长程 RPC 残留由 TTL 兜底
- **per-connId 条目上限**：TTL 已是上限

## 2. 关键约束（来自 OpenClaw 上游）

### 2.1 `reqId` 协议约束

- 非空字符串；无长度上限；无字符集 / 正则约束
- 响应帧的 id 原样 echo
- 服务端**不去重**，无全局唯一性要求

→ UI 可用任意非空字符串作为 reqId；UUID + 任意后缀完全安全。

### 2.2 终态 `res` 判定

协议 schema 层无形式化区分（payload 是 `Unknown`）。**唯一权威判据**来自上游 client
自身：

```
expectFinal && status === "accepted"  → 中间态
                                  其他 → 终态
```

事实：

- 当前会发中间态 `res` 的方法仅 3 个：`agent`、`exec.approval.request`（twoPhase
  模式）、`plugin.approval.request`（twoPhase 模式）
- **唯一已知中间态字符串**：`"accepted"`
- **关键反例**：`chat.send` 的终态 `payload` 是 `{ status: "started" }`——单帧立即
  终态。**不能**用"已知终态字符串黑名单"判据，会卡死 `chat.send`

→ 终态判据用白名单：`status !== "accepted"` 即终态。这与上游 client 严格同构；即使
上游未来引入新中间态字符串而 CoClaw 未及时同步，残留路径会退化为兜底广播，**不丢
响应**。

### 2.3 `connId` 稳定性

- 由 UI 侧生成，贯穿整个 PC 生命周期（含 ICE restart）
- plugin 侧对 UI 的稳定标识

### 2.4 plugin 自发 RPC 与 UI 转发 RPC 的天然隔离

plugin 内部维护**两张独立的 reqId 映射表**：

| 映射表 | 用途 | reqId 前缀 |
|--------|------|----------|
| `gatewayPendingRequests` | plugin 自发 RPC 的 settle | `coclaw-*` |
| `__dcPendingRequests` | UI 转发 RPC 的路由 | `ui-*` |

两表写入路径不同（plugin 自发 vs UI 转发），UI 即使误用 `coclaw-*` 前缀也只占新表
条目，无法跨表污染。响应回来时**先**查 `gatewayPendingRequests`，命中即 settle 并
return，根本不会走到广播 / 定向分支。

## 3. 架构总览

### 3.1 入站（UI → gateway）

```
UI rpc DC ──► plugin onRequest(payload, connId)
              │
              ▼
         等 gateway ready
              │
        ┌─────┴─────┐
        │           │
       失败        成功
        │           │
        ▼           ▼
   广播          撞号检查（同 reqId 已存在 → 删旧 + warn）
   OFFLINE          │
   不写映射          ▼
                写映射 reqId → { connId, expireAt }
                    │
                    ▼
                forward 到 gateway
                    │
              send 抛错？
                ┌─Y─┴─N─┐
                ▼      ▼
            撤回映射  正常返回
            广播       │
            SEND_FAILED
```

### 3.2 出站（gateway → UI）

```
gateway ws message
       │
       ▼
plugin 自发 RPC 命中？─Y─► settle gatewayPendingRequests, return
       │ N
       ▼
event 是 health / tick？─Y─► drop, return
       │ N
       ▼
  停 lag 探针（agent RPC 终态）  ← 必须在下一步之前调用
       │
       ▼
查 __dcPendingRequests
       │
   ┌───┴────┐
   命中     未命中
   │         │
   ▼         ▼
isFinalResMsg？        ┌── res 类型 ──► 广播（兜底，覆盖：
   │                  │                 旧 UI / 撞号第二条 /
 ┌─Y─┴─N─┐            │                 上游新增中间态字符串）
 删条目 留条目        └── event 类型 ─► 广播（设计预期）
   │     │
   ▼     ▼
sendTo(connId, payload)
   │
   ▼
sendTo 成功？
 ┌─Y─┴─N─┐
 完成   本地 log 丢弃（不退回广播）
        return
```

`stop lag 探针` 必须在 `sendTo` 之前调用——否则 sendTo 命中后探针不停，会跑到 60s
兜底，期间持续打 spike 噪声。

## 4. UI 侧设计

### 4.1 `reqId` 格式

```
ui-<uuid>-<counter>
```

- **`ui-` 前缀**：与 plugin 自发 RPC 前缀（`coclaw-*`）形成统一命名约定，跨端日志
  可一眼识别请求来源
- **`<uuid>`**：每个 ClawConnection 实例**构造时生成一次**（`crypto.randomUUID()`），
  后续该连接的所有请求复用，保证跨连接唯一
- **`<counter>`**：连接内自增

设计要点：UUID 保证跨连接唯一；counter 保证同连接内单调。两者组合后，**新 UI 永远
不会撞号**。

### 4.2 不动的部分

- `__pending` 表的 key 仍是完整 reqId 字符串
- 两阶段响应识别（看到 `accepted` 不删条目，看到终态才删）
- 超时、`onAccepted` 回调等

## 5. Plugin 侧设计

### 5.1 终态判定 `isFinalResMsg`

```
isFinalResMsg(frame) = frame.type === 'res' && frame.payload.status !== 'accepted'
```

设计要点：

- 与上游 `expectFinal && status === "accepted"` 严格镜像
- **不复用** lag 探针的 `classifyAgentLagStop`——后者返回原因字符串（供日志用），与
  路由"清条目"语义不同。两者判据相似但语义边界不同，各自独立
- 上游若未来新增中间态字符串：被当成终态提前清条目，残留响应退化为广播兜底——
  **不丢响应**

### 5.2 入站请求处理

签名 `(payload, connId)`，由 webrtc-peer 提供 connId。

处理顺序：

1. 等 gateway ready
2. ready 失败 → 广播 `GATEWAY_OFFLINE`，**不写映射**（无脏映射）
3. ready 成功 → 撞号检查：同 reqId 已存在 → 删旧 + warn
4. 写映射 `reqId → { connId, expireAt: now + TTL }`
5. forward 请求到 gateway
6. send 抛错 → 撤回映射 + 广播 `GATEWAY_SEND_FAILED`

**写映射的时序窗口**：必须在 ready 通过 **之后**、send 调用 **之前**。两端用代码
顺序锚定，不存在脏映射可能。

**`connId` 缺失防御**：理论上 webrtc-peer 调用侧必传，`if (connId)` 是纯防御。
缺失时退化为旧广播行为（不写映射 → 后续响应走兜底广播分支）。

### 5.3 出站响应分发

ws message 顺序处理（前一阶段未 return 才进入下一阶段）：

1. plugin 自发 RPC settle（通过 `gatewayPendingRequests`）
2. health / tick 事件过滤
3. lag 探针停止（agent RPC 终态）—— **位置不可变**，必须在 (4) 之前
4. 单播分支：查 `__dcPendingRequests`
   - 命中 + 终态 → 清条目 → `sendTo(connId, payload)` → return
   - 命中 + 中间态（accepted） → 保留条目 → `sendTo(connId, payload)` → return
   - `sendTo` 返回 false（PC 已断 / DC 未 open / 队列拒收） → 本地 log 丢弃，
     **不退回广播**（其他 UI 不应收到无关响应）
5. 兜底广播 `webrtcPeer.broadcast(payload)`
   - 覆盖：event 类型、单播未命中（旧 UI / 撞号第二条 / 上游新中间态等）

### 5.4 撞号处理

**场景**：UI 误用相同 reqId。新 UI 因 UUID 永不触发；旧 UI 跨 tab 可能触发。

**处理**：删旧条目 + warn + 写新条目。

**结果**：gateway 不去重，会回**两条**同 id 响应——

- 第一条到达：单播给**当前登记的发起方** + 清条目
- 第二条到达：记录已清，走广播兜底

设计目标"响应至少送到原 UI"在所有路径下成立——旧发起方通过广播兜底仍能收到响应。
无效广播只是节流问题，可容忍。

**已知风险（仅旧 UI 跨 tab 场景）**：旧 UI 的 `__pending` 按 id 匹配，新发起方可能
**误把旧请求的响应 settle 成新请求结果**。这是旧 UI 自身的存量问题（在没有本方案
前也存在），新插件不让它变得更糟。新 UI 因 reqId 跨连接唯一，不会触发此场景。

### 5.5 异常响应保持广播

`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 属系统状态公告，保留广播。理由：

- OFFLINE 在写映射前触发，无脏映射可清
- SEND_FAILED 已撤回映射后再广播
- 系统状态对所有 UI 都有意义；定向化收益小、代价大（改造面 + 两端协议确认 + 测试
  覆盖都更复杂）

### 5.6 路由表生命周期

| 时机 | 动作 |
|------|------|
| 写入 | 入站请求 ready 通过后、send 之前 |
| 单播命中（终态） | 清该条目 |
| 单播命中（中间态 `accepted`） | 保留条目，等下一帧 |
| gateway WS 断开 | **清空整表**；不主动通知 UI，UI 自行 30/60s 超时 |
| PC 断开 | **不**主动清映射；正常响应到达自然清理；长程 RPC 残留靠 TTL 兜底 |
| TTL 过期 | 周期扫描清过期条目 |

**TTL 选 24h**：agent run 极端可达数小时甚至更久；正常 RPC 在终态触达前已自然清除；
24h 足够覆盖几乎所有真实场景，且条目内存压力可忽略（百量级 × 几十字节）。

**周期扫描 1h**：条目存留误差 0~1h，对内存压力毫无影响。整表共享一个 timer，
**不**为每条挂独立 timer——避免上百条 timer 增加调度负担。扫描器需 try/catch 兜底
（插件运行在 gateway 进程内，禁止全局异常兜底）。

**PC 断开不清映射**的理由：

- 正常 RPC 响应通常很快回来，自然清掉绝大多数条目
- 长程 RPC（如 agent run）的死条目数量不会大（同时挂起的几个）
- 主动清的代价：触发后续 gateway 响应"找不到映射" → 退回广播 → **反而推高广播量**
- TTL 兜底已足够防泄漏

**gateway WS 断开不通知 UI** 的理由：

- 给所有 owner 主动通知的复杂度（多 connId 并发、错误处理、与 PC close 时序竞争）较高
- gateway 与插件同进程，触发频率本身极低
- 牺牲一点 UI 等待延迟换简化是划算的

## 6. 兼容矩阵

| UI | 插件 | 行为 |
|----|------|------|
| 旧 | 旧 | 全广播（现状） |
| 新 | 旧 | 全广播（旧插件不解析 id 格式，完全兼容） |
| 旧 | 新 | 按 id 单播；跨 tab 撞号时走 §5.4 撞号路径 |
| 新 | 新 | 按 id 单播 |

新 UI 发布到新插件发布之间，行为退化为旧广播。新插件部署后自动进入新路径。

## 7. 灰度与回滚

- 兜底广播分支**自带灰度降级能力**——映射表异常 / 未命中时自动退化到旧行为，不需要
  额外 feature flag
- 回滚方向：UI 改 reqId 格式 / Plugin 移除单播分支，两端独立可回滚，无跨端协调

## 8. 验收要点

新设计的稳定性靠以下断言保证：

- **不丢响应**：所有路径都通过单播或广播兜底确保原 UI 收到响应
- **`isFinalResMsg` 与上游同构**：上游引入新中间态字符串时残留路径退化为兜底广播，
  仍不丢
- **lag 探针位置不可移**：必须在单播分支之前调用
- **`sendTo` 失败不退回广播**：避免污染其他 UI
- **写映射时序锚定**：ready 后、send 前
- **撞号路径满足"至少送到原 UI"**：第一条单播 + 第二条广播兜底
- **timer 强约束**：周期扫描共享一个 timer + try/catch 兜底 + `unref`
