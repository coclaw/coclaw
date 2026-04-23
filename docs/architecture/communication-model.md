# CoClaw 通信模型

> 最后更新：2026-04-08
> 状态：已实施
> 范围：UI ↔ Plugin 的端到端通信架构，含信令、数据通道、超时与连接生命周期

---

## 一、总览

CoClaw 的通信架构可以用 **HTTP 客户端** 来类比理解：

| HTTP 概念 | CoClaw 对应 | 说明 |
|-----------|-------------|------|
| TCP 连接池 | Per-claw WebRTC 连接（`WebRtcConnection`） | 每个 claw 一条持久化 P2P 连接 |
| TCP keepalive | ICE keepalive + Signaling 心跳 | 连接保活由 WebRTC 框架和信令层分别负责 |
| HTTP request/response | JSON-RPC over DataChannel | 基于 `rpc` DC 的请求-响应模式 |
| HTTP client | `ClawConnection` | 封装连接管理 + 请求发送，业务层无需关心底层连接状态 |
| `connectTimeout` | 等待 DC 就绪（`waitReady`） | 连接建立阶段的超时 |
| `requestTimeout` | 等待 RPC 响应 | 请求发送后到收到响应的超时 |

核心设计意图：**业务层像发 HTTP 请求一样调用 `conn.request()`，无需关心底层 WebRTC 连接是否已建立**。连接不可用时自动等待，超时后明确报错。

---

## 二、三层通道架构

```
UI Browser                         Server                        Plugin (OpenClaw)
──────────                         ──────                        ─────────────────

SignalingConnection ─── WS /rtc/signal ──► rtc-signal-hub          │
(per-tab 单例,                             (信令路由)               │
 多 connId)                                                        │
                    ─── WS /claws/stream ► claw-ws-hub ◄──WS /claws/stream── Plugin
                       ?role=ui            (RPC 中继 +              (token 认证)
                       (ticket 认证)         信令转发)

ClawConnection ══ DC "rpc" (持久) ════════════════════════════════► Gateway RPC
(per-claw)    ═══ DC "file:<id>" (临时, per-transfer) ═══════════► 文件读写
```

> 注：Server 同时接受 `/api/v1/bots/*` 和 `/api/v1/claws/*` 路径（路由别名），旧版客户端兼容。

### 2.1 Signaling 通道（WebSocket）

- **连接形态**：per-tab 单一 WS（`SignalingConnection`），承载所有 claw 的信令
- **端点**：`WS /api/v1/rtc/signal`，session cookie 认证
- **职责**：SDP/ICE 交换、connId 管理、应用层心跳（25s ping / 45s 超时）
- **不承载**业务数据——业务 RPC 和文件传输均走 DataChannel
- connId 由 UI 生成并 claim，WS 重连后通过 re-claim 恢复映射，避免 full rebuild

### 2.1b Server-relayed RPC 通道（WebSocket，保留能力）

> **当前状态**：Server 侧已实现，UI 侧未使用。作为 WebRTC DataChannel 的补充路径保留，后续可能启用。

- **连接形态**：UI 以 `role=ui` 连接 claw-ws-hub（`WS /api/v1/claws/stream?role=ui`）
- **认证**：优先 session cookie，兼容一次性 ticket（`POST /api/v1/claws/ws-ticket` 生成，60s TTL）
- **职责**：Server 中继 RPC 请求/响应（UI `req` → Server 转发给 Plugin → Plugin `res` → Server 广播给 UI），同时也能承载 RTC 信令
- **定位**：WebRTC DataChannel 的补充路径。Plugin 离线时 Server 可直接返回 `BOT_OFFLINE` 错误，无需等待 DC 超时

### 2.2 RPC 通道（DataChannel `rpc`）

- **连接形态**：per-claw 持久化 DataChannel，基于 SCTP，可靠有序
- **职责**：所有 JSON-RPC 请求-响应（agent 交互、session 管理、文件元操作等）
- **协议**：`{ type: "req", id, method, params }` → `{ type: "res", id, ok, payload }` + `{ type: "event", event, payload }`
- P2P 优先，不可达时自动经 TURN 中继，对应用层透明

### 2.3 File 通道（DataChannel `file:<transferId>`）

- **连接形态**：per-transfer 临时 DataChannel，传输完成即关闭
- **职责**：二进制文件传输（下载/上传/附件上传）
- **协议**：HTTP 语义映射——string 帧 = 控制信息（GET/PUT/POST + 状态码），binary 帧 = 数据
- 与 `rpc` DC 互不阻塞——大文件传输不影响 RPC 响应性
- **UI 层抽象**：`coclaw-file://clawId:agentId/path` URL 协议，提供连接无关的文件标识与按需获取能力（详见 `designs/file-management.md` 第七章）

---

## 三、ClawConnection 抽象

`ClawConnection` 是业务层与通信层的唯一接口，每个 claw 对应一个实例。

### 3.1 核心职责

```
┌─────────────────────────────────────────────────┐
│                  ClawConnection                   │
│                                                   │
│  request(method, params, options)                  │
│    → 自动 waitReady → 发送 RPC → 等待响应          │
│                                                   │
│  waitReady(timeoutMs)                              │
│    → DC 已就绪：立即返回                            │
│    → DC 未就绪：排队等待 setRtc() 触发              │
│    → rtcPhase='failed'：主动触发重连                │
│                                                   │
│  setRtc(rtcConn)   → resolve 所有 waiters          │
│  clearRtc()        → reject 所有 waiters + pending │
│  disconnect()      → close RTC + reject all        │
│                                                   │
│  on/off('event:<name>')  → 事件监听                │
└─────────────────────────────────────────────────┘
```

### 3.2 与 Store 层的协作

`claws.store` 通过注入回调实现跨层协作，避免 `ClawConnection` 依赖 Vue 响应式系统：

- `__onTriggerReconnect`：`waitReady` 发现 `rtcPhase='failed'` 时调用，触发 RTC 重建（fire-and-forget）
- `__onGetRtcPhase`：读取当前 claw 的 `rtcPhase` 状态（`idle` / `building` / `ready` / `recovering` / `failed`）

### 3.3 连接获取的两种模式

| 模式 | 获取方式 | 语义 | 适用场景 |
|------|---------|------|---------|
| 等待模式 | `useClawConnections().get(clawId)` + `request()` | 连接不可用时自动等待恢复 | 关键操作：发消息、重置会话、文件传输 |
| 快速失败模式 | `getReadyConn(clawId)` | 连接不可用时立即返回 null | 非关键操作：加载消息列表、UI 渲染守卫 |

---

## 四、两层超时模型

`request()` 的超时分为两个独立阶段，**顺序执行、互不重叠**：

```
                 connectTimeout              requestTimeout
              ├────────────────────┤├──────────────────────────────┤
调用 request()                   DC 就绪                        收到响应
              │  等待连接建立/恢复  │  等待 RPC 响应               │
              │  (waitReady)       │  (pending promise)           │
```

### 4.1 connectTimeout（连接等待超时）

- 默认：**120s**（`DEFAULT_CONNECT_TIMEOUT_MS`）—— 覆盖底层 RTC 一次 ICE restart 90s 预算 + 余量
- 触发条件：调用 `request()` 时 DC 尚未就绪
- 超时错误码：`CONNECT_TIMEOUT`
- 快速路径：DC 已就绪时跳过，直接进入发送阶段
- 可通过 `options.connectTimeout` 覆盖；可通过 `options.signal` 主动取消等待（详见 §4.5）

### 4.2 requestTimeout（请求响应超时）

- 默认：30s（`DEFAULT_REQUEST_TIMEOUT_MS`）
- 通过 `options.timeout` 覆盖，`timeout: 0` 表示永不超时
- 超时错误码：`RPC_TIMEOUT`
- DC 断开时由 `clearRtc()` 统一 reject（错误码 `RTC_LOST`）
- 可通过 `options.signal` 主动取消等待（详见 §4.5）

### 4.3 业务层超时配置

不同 RPC 方法按业务特性配置不同的 requestTimeout：

| 超时 | 方法 | 理由 |
|------|------|------|
| 0（永不超时） | `agent` | 长时运行的 Agent 任务，自身有 180s(pre-accept) / 24h(post-accept fallback) 超时管理 |
| 600s | `sessions.reset` | Agent 收尾工作（记忆处理等）可能耗时较长 |
| 600s | `coclaw.topics.generateTitle` | LLM 生成，耗时不可预测（需覆盖插件内 agent-rpc 300s + 通信/排队 buffer）|
| 120s | `sessions.get`、`coclaw.sessions.getById` | Session 内容可能较大 |
| 60s | `coclaw.topics.list`、`coclaw.chatHistory.list`、`coclaw.files.list`、`coclaw.files.delete` | 元数据列表或递归操作 |
| 30s（默认） | 其他所有 RPC | 轻量级操作 |

### 4.4 文件二进制传输的超时

文件二进制传输（`downloadFile`/`uploadFile`/`postFile`）使用 `waitReady()` 确保连接就绪后创建临时 DataChannel，传输阶段不设置超时——文件大小不可预知，且 DC 断开会自然终止传输。

DC open 后额外有一层 `READY_TIMEOUT_MS = 120s` 的守卫，等待 Plugin 回复首条控制消息（响应头或 ready 信号）。

### 4.5 请求取消（AbortSignal）

`request()` 和 `downloadFile/uploadFile/postFile` 均支持 `options.signal` / `opts.signal` 参数（AbortSignal），语义与 fetch/axios 对齐：signal 覆盖**连接等待 → 等响应头 → 流式收发**三段完整生命周期，任一阶段被 abort 都立即 reject，不做任何 DC I/O。

- 错误形态：`err.name = 'CanceledError'`，`err.code = 'ERR_CANCELED'`（对齐 axios v0.22+）
- 传入已 abort 的 signal → 同步 reject，不发起任何 I/O
- 文件传输的 `handle.cancel()` 向后兼容保留，内部等价于 `controller.abort()`
- ERR_CANCELED 不在断连错误集合中（`DISCONNECT_CODES`），不会触发上层自动重试

**为什么要覆盖整个等待周期**：底层 RTC 恢复最长可达 ~3 分钟（ICE restart 90s + rebuild 退避），应用层通过长 connectTimeout 加上 signal 主动取消来表达"是否继续等"，与 fetch 心智一致——调用方不关心下层在哪个恢复阶段。

---

## 五、连接生命周期

### 5.1 正常建连

```
1. claws.store 创建 ClawConnection 实例
2. claws.store 通过 SignalingConnection 发起 RTC offer
3. ICE 协商完成，DataChannel 'rpc' 打开
4. claws.store 调用 conn.setRtc(rtcConn)
5. 所有 waitReady() 的等待者被 resolve
6. 排队中的 request() 开始发送
```

### 5.2 断连与恢复

```
DC 断开（网络抖动、前台恢复等）
  → claws.store 调用 conn.clearRtc()
  → 所有 pending request 被 reject (RTC_LOST)
  → 所有 readyWaiters 被 reject (RTC_LOST)
  → claws.store 发起 RTC 重建
  → 重建成功后调用 conn.setRtc(newRtcConn)
  → 新的 request() 可正常工作
```

### 5.3 前台恢复场景

移动端 App 或浏览器 Tab 从后台恢复时：

1. `SignalingConnection` 检测前台恢复事件
2. 探测 WS 连通性（probe ping，超时 2.5s）
3. WS 不通 → 重建 WS → re-claim connId
4. RTC 不通 → claws.store 触发 RTC 重建
5. 恢复期间的 `request()` 自动排队等待

### 5.4 RTC Phase 状态机

```
idle → building → ready ⇄ recovering
                    ↓         ↓
                  failed ← failed
```

- `idle`：初始状态，未开始建连
- `building`：正在协商 ICE/SDP
- `ready`：DC 已打开，可用
- `recovering`：检测到断连，正在重建
- `failed`：重试耗尽，需要外部触发重连

`waitReady()` 在 `failed` 状态下会自动调用 `__onTriggerReconnect` 触发新一轮重连尝试。

### 5.5 claw.online 与 DC 恢复路径的协调

**`claw.online` 是 presence 信号，不作为 DC 是否可用的判据；但主动恢复动作（ICE restart / rebuild / retry 调度）以它为门控**——offline 时暂停，online 时分派。

- 来源：SSE `claw.status` / `claw.snapshot` / `claw.bound` 事件的**内容**驱动
- 与 SSE 连接本身的存亡**无关**：SSE 断开/重连不会把所有 claw 刷成 offline
- 与 DC 是否可用解耦：不参与 `dcReady` / `rtcPhase` 的直接赋值，也不作为"DC 通不通"的断言

**为什么引入 online 门控（从"完全解耦"变为"恢复路径看 online"）**：WebRTC 已相当稳定（ICE restart 90s 预算内多能成，rebuild 兜底可靠），但 plugin 离线时，ICE restart offer 送过去没有 plugin 可接（server 无法 relay 到已断的 plugin），restart 预算必然白烧；退避重试也会在无接收方的情况下空转 5 轮。所以：**plugin 不在线的时间对 RTC 恢复而言是"时间停止"——所有预算、计数冻结，PC 保留，等 online 回来视为新一轮事件。**

**SSE claw.online=false 时 UI 的动作**（由 `__handleClawGoOffline(id)` 统一封装）：

```
SSE claw.status {online:false}
  → claws.store.updateClawOnline(id, false)
  → claw.online = false   （仅更新展示字段；不写 dcReady/rtcPhase/disconnectedAt）
  → __handleClawGoOffline(id):
      1. _lifecycle.syncDashboardOffline(id)   （dashboard 展示层同步）
      2. __clearRetry(id)   （取消排队中的退避重试定时器）
      3. conn.rtc?.pauseRestart()   （按 state 暂停 UI 主动恢复动作）
```

`pauseRestart()` 按 `rtc.__state` 分派，不改变 `__state`：

- **`restarting`**：停 restart timer / stats poll；清预算（restartStartTime/AttemptCount/OfferSentAt/UfragSnap）；epoch++；设 `__restartPaused=true`
- **`connected`**：停 keepalive；清 disconnected timer（防止 keepalive probe 失败或 disconnected 超时经 `__onIceFailed` 升级成空发 offer 的 restart）；epoch++；设 `__restartPaused=true`
- **`idle`/`connecting`/`failed`/`closed`**：no-op

**PC/DC 生命周期不被 presence 污染**：`dcReady` / `rtcPhase` / `disconnectedAt` 只由 RTC 状态机（`onRtcStateChange` / `dc.onclose` / `__ensureRtc`）按真实 DC 状态维护。offline 期间如果 DC 仍 open（SCTP 跨 ICE restart 存活），`dcReady` 保持 `true`、`getReadyConn` 正常返回 conn、pending RPC 继续通过 `waitReady()` 排队等 SCTP 送达——这是 1ef6782 确立的"两条通路独立"原则。

`__attemptRestart` 入口有 `paused && reason !== 'online_resume'` gate：任何自动路径（`__onIceFailed` / periodic timer / nudge / ICE 事件）尝试在 paused 态触发 restart 都被 drop；只有显式的 `triggerRestart('online_resume')` 能穿过 gate。gate 后的 `epochAtEntry` guard 额外覆盖"`pauseRestart` 发生在 `await sig.ensureConnected()` 或 `await createOffer` 期间"的跨 await 窗口。

**SSE claw.online=true（从 false 转来）时 UI 的动作**（由 `__resumeOnline(id)` 强制刷新 + 按 PC 状态分派）：

```
SSE claw.status {online:true} 或 claw.snapshot diff 检测到 online: false→true
  → claws.store.updateClawOnline(id, true) / applySnapshot Phase 3
  → __resumeOnline(id):
      1. __clearRetry(id)
      2. force refresh 分流（关键：按 rtc.state 决定立即刷还是延后）：
         - DC 预期可用（'connected' / 'restarting'，SCTP 多能存活）→ 立即
           __refreshIfStale(id, {force:true})（loader 可用 dcReady=true 发 RPC）
         - 需要 rebuild（rtc 不存在 / 'failed' / 'closed' / 'idle' / 'connecting'）→
           add id 到 `_pendingForceRefreshOnRebuild` Set；任何一次 __ensureRtc 真正
           成功时 consume 该标记并 force refresh。此机制可靠覆盖：
             * `_rtcInitInProgress` 守卫下 __ensureRtc 早退（.then 立即 fire 但
               rebuild 未完成）
             * 当前 __ensureRtc attempts 全失败、等退避重试多轮后最终成功
      3. 按 rtc.state 分派动作：
         - 'restarting' + restartPaused → rtc.triggerRestart('online_resume')
           （复用 PC + 全新 90s 预算；paused gate 仅此路径可穿过）
         - 'restarting' + 非 paused → 已在正常 restart 循环，不重入
         - 'connected' + restartPaused → rtc.resumeRecovery()
           （清 paused + 重启 keepalive；不触发 ICE restart，PC 本身仍健康）
         - 其余 → __ensureRtc(id).then(force refresh? + loadDashboardForClaw)
```

**`__refreshIfStale(id, {force})`** 有两种语义：
- `force=false`（默认）：RTC 层断连恢复后的"顺便刷"——看 `disconnectedAt` gap，短于 `BRIEF_DISCONNECT_MS` 跳过（浏览器短暂切后台、网络闪断不值得全量刷）。由 `onRtcStateChange('connected')`（wasDisconnected=true 分支）和 `__ensureRtc` rebuild 成功路径调用
- `force=true`：presence 恢复后的"必须刷"——跳过 gap，只要 `initialized` 就刷。只由 `__resumeOnline` 调用。语义：plugin 真的离线过（不管多短），UI 数据一定可能 stale，不赌概率

`onRtcStateChange('connected')` 的 wasDisconnected=false 分支（ICE restart 成功但 DC 全程未断）也会把 `disconnectedAt=0`——修复 pre-existing 漏洞：多次 restart 间 stamp 会累积最旧时刻污染后续 gap 判断。

**已知限制**：offline 期间 `pauseRestart` 停了 keepalive 探测，SCTP 若静默死亡（plugin 进程挂但浏览器未检测到底层 transport 故障）`dcReady` 会脱钩保持 `true`。resume 时 `resumeRecovery` 重启 keepalive，首次 probe 间隔 30s 内 UI 以为 DC 可用，期间 RPC 写入 SCTP buffer 但送不到 plugin——最终通过 keepalive probe 失败升级为 `__onIceFailed` → ICE restart 或 rebuild 被动恢复。这是"presence 与 DC 生命周期独立"原则的权衡：后续可选在 `resumeRecovery` 里加 immediate probe 缩短探测时延。

**`applySnapshot` 的三阶段 diff**：Phase 1 capture prev online → Phase 2 apply snapshot（覆盖字段）→ Phase 3 按 `online: true→false` / `false→true` / 未变但 `rtcPhase='failed'` 分派动作，覆盖 SSE 断连重连且 server 没发增量 `claw.status` 的场景。

**online 门控的布点**：
- `__ensureRtc` 入口 + 循环中途 → offline 即 bail-out；循环中途 bail-out 显式写 `rtcPhase='failed'`，让后续 online→true 走 rebuild 分支
- `__scheduleRetry` 入口 → offline 不排队退避
- `__checkAndRecover` 入口 → offline 不 probe、不 restart
- `__handleNetworkOnline` 循环内 → offline 的 claw 不参与 network 恢复路径

**其他 online 消费点**：
- 展示（banner、徽标、列表排序、操作可用性提示）：**允许**，UI 优先用 `online=false` 表示"离线"而非"连接失败"，即使 `rtcPhase='failed'`
- 首次 init 的启动先验（`__bridgeConn` 决定是否对未初始化的 claw 立即建 DC）：**允许**——建连成本不低，明确离线时不白跑
- 手动重试（`manualRetryUnreachable`）：`unreachableClaws` getter 已过滤 `online`；极罕见竞态下 `__ensureRtc` 的 gate 会静默 skip，语义正确

### 5.5.1 信令 WS gate（第二把锁）

`claw.online` 解决"plugin 有没有 online"。但**信令 WS（浏览器↔server）不通**的场景（电梯/地下车库/飞行模式/WiFi↔蜂窝瞬断/server 重启）下，ICE restart offer 送不出 server、rebuild 的 signaling 握手也送不出——与 plugin offline 对称，**所有 RTC 主动恢复动作都是空烧预算**。故引入第二把并列的锁 `_sigOffline`：信令 WS 不通时全局冻结所有 claw 的 ICE restart / rebuild / 退避计数。

**信号源唯一**：`SignalingConnection.on('state', cb)` 事件。不用 `navigator.onLine`，不用 Capacitor Network 的 offline 分支。理由：
- `navigator.onLine` 在桌面浏览器准确度低（VPN / 本地代理 / 局域网无网均可能误报 true/false）
- Capacitor Network `connected=false` 仅反映系统路由层，不等价于"WS 到 server 可达"——server 重启时系统路由正常但 WS 不通
- `sig.state` 直接反映 WS 握手/心跳结果，是"能否向 server 发 signaling"这件事本身的度量，无代理偏差

**判定**：`_sigOffline = (sig.state !== 'connected')`。`connecting` 也算 offline——`__sendRaw` 在 `ws.readyState !== 1` 时直接返回 false，与 disconnected 行为一致；WS 层自身已在指数退避重连，store 层不需要二次 debounce。

**UI 动作**（`__bridgeLifecycle` 的 sigState handler 分派）：
- 进入（`connected → 非 connected`）：`__freezeAllClawsForSigOffline()` 遍历 `byId`，对每个 claw 调 `__clearRetry(id)` + `conn.rtc?.pauseRestart()`。**不调** `__handleClawGoOffline`——后者会 `syncDashboardOffline`，而 sig 不通时 plugin 可能仍 online，dashboard 不应联动
- 退出（`非 connected → connected`）：`__resumeAllClawsForSigOnline()` 遍历 `byId`，对 `claw.online === true` 的调 `__resumeOnline(id)`；`claw.online === false` 的不动（等 SSE online 回来走单独路径）

**两把锁独立、两把都开才恢复**。协调核心：`__resumeOnline` 入口 `if (_sigOffline) return`——任意一把锁关闭都阻断恢复动作；sig online handler 与 claw online 事件无论先后，最晚那次触发才真正执行 resume。

**gate 布点**（与 online gate 平行的 5 处）：
- `__ensureRtc` 入口 + 循环中途 → sig 不通即 bail-out；循环中途 bail `bailReason='sig_offline'`，**不**写 `rtcPhase='failed'`（sig 是环境故障，恢复后继续 rebuild，不应被标为 unreachable）
- `__scheduleRetry` 入口 → sig 不通不排队退避
- `__checkAndRecover` 入口 → sig 不通不 probe、不 restart
- `__handleNetworkOnline` 入口 → sig 不通时整个循环跳过
- `__resumeOnline` 入口 → 两把锁协调核心

**初始挂 listener 时的同步**：`SignalingConnection.on('state', ...)` 不会立即回调（仅在状态变更时派发）。`__bridgeLifecycle` 挂 listener 后主动读一次 `sig.state`，若非 connected 立即 `_sigOffline=true` + 调 freeze，覆盖"登录瞬间 sig 仍在 connecting"场景。乐观默认 `_sigOffline=false`。

**forceReconnect 二连发**：`sig.forceReconnect()` 同步派发 `disconnected → connecting` 两次 state 事件。handler 最外层 `if (shouldBeOffline === _sigOffline) return` 确保 freeze/resume 只跑一次。

**心智模型**：sig gate 不是"RTC 依赖 WS 的连接状态"，而是 RTC 和 WS 都读取同一个公共的**端到端可达性**信号——WS 顺手承担了探测职责。对比替代方案：OS 级 `navigator.onLine` 或 Capacitor Network 只看本地网卡，电梯 / 地下车库 / server 故障时仍报 online，假阴性严重；应用级 WS heartbeat 是真正的端到端探测，上述场景都能准确感知。WS 的地位是"顺手承担 heartbeat 职责的长连接"，不是业务依赖。

**typeChanged 跨恢复路径记账**（`_pendingTypeChangedRestartClaws`，per-claw Set）：`network:online(typeChanged=true)` 要覆盖所有"发生换网时暂不能立刻 ICE restart，之后某刻才恢复"的 claw——否则这些 claw 下次走 `resumeRecovery()` 会复用已失效的旧 ICE 路径（IP 已变），等 ~30s consent 超时才被动 restart。

记账法：`__handleNetworkOnline(typeChanged=true)` 入口（sig gate 之前）对每个 claw 判断"本次循环是否会立刻发起有效 restart"——仅"sig 通 + `claw.online` + `initialized` + `connected` + `!restartPaused`"的走下方循环 `triggerRestart('network_type_changed')`；**其余全部 `add(id)` 到 Set**（包括 offline / sig offline / paused / restarting / failed / 未 initialized / rtc=null）。消费在 `__resumeOnline(id)` 入口唯一点：`delete(id)` 的返回值直接作为 `forceRestartOnConnected` 信号——命中则将 `connected+paused` 分派升级为 `rtc.triggerRestart('online_resume')`。

覆盖的三条漏网路径（对应早期 boolean 版本无法处理的场景）：
- **sig 通 + claw offline + typeChanged**：claw 回 online 时由 `updateClawOnline` 调 `__resumeOnline` 消费
- **sig offline + typeChanged + sig resume 时 claw 仍 offline**：claw 后续回 online 时由 `__resumeOnline` 消费（sig resume 的 `__resumeAllClawsForSigOnline` 对 offline claw 不动）
- **多 claw 同时离线并先后恢复**：每个 claw 独立持有 Set 条目；不再互相抢 boolean

**paused 态特殊规则**：`connected + restartPaused + typeChanged` 在主循环不发 `triggerRestart('network_type_changed')`——`WebRtcConnection.__attemptRestart` 的 paused gate 只接受 `'online_resume'` 为穿透原因（其他 reason 一律 drop）；若在此发 restart 会被 drop，若同时清 Set 则信号永久丢失。故主循环在 paused 子分支直接 `continue`，Set 条目保留给后续 `__resumeOnline` 消费时升级为 `'online_resume'` triggerRestart（唯一能穿透 paused gate 的 reason）。

清理点（所有"新 ICE 路径建成"或"信号消费"路径同步 delete，防止陈旧条目在下次 resume 虚发）：
- `__resumeOnline` 消费（唯一读点，`delete(id)` 的返回值即 forceRestartOnConnected 信号）
- `__handleNetworkOnline` 主循环三分支（`restarting → nudgeRestart`、`connected + !paused + typeChanged → triggerRestart('network_type_changed')`、`failed/closed → rebuild`——都在本次调用中产生新 ICE 路径）
- `__ensureRtc` 成功（rebuild 成功即新路径）
- `updateClawOnline` `!initialized` 分支 / `__resumeAllClawsForSigOnline` `!initialized` 分支（`__fullInit` 建全新路径）
- `removeClawById` / `applySnapshot` 清理循环（claw 从 `byId` 消失）
- `__resetClawStoreInternals`（logout / 测试）

---

## 六、Agent 两阶段响应

`agent` 方法采用特殊的两阶段响应协议（详见 [gateway-agent-rpc-protocol.md](gateway-agent-rpc-protocol.md)）：

```
request(id) ──────────────────────────────────────────────────── time
             │                                                    │
             ▼ res(status=accepted)    events(stream)    res(status=ok/error)
             │  ← ack, 不 resolve      ← 流式推送        ← 终态, resolve/reject
```

- `status: "accepted"` — 中间态，通过 `onAccepted` 回调通知调用方
- `status: "ok"` / `"error"` — 终态，resolve 或 reject promise
- 执行期间通过 `event:agent` 推送流式数据（assistant/tool/thinking/lifecycle stream）
- `timeout: 0`——Agent 任务不设置客户端超时，由 Agent 自身管理执行超时

---

## 七、架构分层

```
┌──────────────────────────────────────────────────────┐
│                  Vue 组件层                             │
│  ChatPage / FileBrowser / ManageClawsPage / ...       │
│  只从 Store 读数据，通过 Store actions 触发操作          │
└────────────────────────┬─────────────────────────────┘
                         │ reactive (Pinia)
┌────────────────────────┴─────────────────────────────┐
│                  Pinia Store 层                         │
│  claws.store / chat.store / files.store / ...          │
│  状态管理、RTC 生命周期编排、业务逻辑                     │
└────────────────────────┬─────────────────────────────┘
                         │ 调用 request() / on() / off()
┌────────────────────────┴─────────────────────────────┐
│                  Service 层（纯 JS，无 Vue 依赖）       │
│  ClawConnection ── 业务 RPC + 连接等待                  │
│  SignalingConnection ── 信令 WS + connId + 心跳        │
│  WebRtcConnection ── ICE/SCTP/DataChannel 管理         │
│  file-transfer ── 二进制文件传输（临时 DC）              │
└──────────────────────────────────────────────────────┘
```

Service 层的三个核心类各司其职：

| 类 | 粒度 | 职责 |
|----|------|------|
| `SignalingConnection` | per-tab 单例 | 信令 WS 生命周期、心跳、connId claim、前台恢复探测 |
| `WebRtcConnection` | per-claw | ICE 协商、SCTP 通道、DC 管理、连通性检测 |
| `ClawConnection` | per-claw | 业务 RPC 抽象、连接等待、事件分发——**业务层唯一接口** |
