# CoClaw UI 通信协调现状梳理（工作文档）

> **状态**：WIP 讨论稿，不是正式文档
> **目的**：作为我们讨论"claw / WS / RTC / OS 网络"这四路状态当前耦合方式的共同基础
> **更新策略**：每轮讨论后基于新理解修订本文件
> **最后修订**：2026-04-24
> **不覆盖**：`docs/state-recovery.md`（那是正式文档，本文件用于讨论现状及后续方案对比）

---

## 总体拓扑：四路信号 + 一个协调中心

```
[OS online / foreground] ─┐
[信令 WS 状态]            ├─► claws.store（协调中心）─► 驱动 RTC 和 claw 的恢复动作
[claw online（服务端推）]  ─┤
[RTC 状态机自报]          ─┘
```

**关键心智模型变化**：信令 WS 不再只是一条信令通道，被**悄悄提升成了"端到端可达性信号"**——"WS 不通 = 对业务而言，网络就是不通"。这是最近这轮加法的核心改动。四路信号在 `claws.store` 里汇成一把全局闸（`_sigOffline`）和五个 gate 点。

---

## 1. 信令 WS（SignalingConnection）

**职责**：维护 per-tab 唯一的一条信令 WebSocket，管心跳、重连、connId 分配。

**自身状态**：三态 `disconnected / connecting / connected`，外加"进入这个态的时刻"和"最后收到消息的时刻"用来判卡死。

**听哪些外部事件**：前台恢复、网络 online（带 typeChanged 标记）、WS 自身 open/close/error。

**内部处理**：
- OS 报离线时**不建 WS**，只安排退避重连，且**只打一条"暂停"日志**（最新那个 commit 加的降噪闸，边沿触发）
- 在线但 WS 态卡在 connecting 超 15 秒，或 connected 但 45 秒没收到任何消息 → 强制重连
- 前台恢复和 network:online 会根据"后台多久"/"是否换网络"决定是强重连、轻探测还是啥都不干

**对外协作**：纯事件总线（`on('state' | 'log' | 'rtc')`）。**它本身不知道 claw 和 RTC 的存在**。

---

## 2. 每个 claw 的 RTC 连接（WebRtcConnection）

**职责**：维护 per-claw 的 RTCPeerConnection + DataChannel，管 ICE restart、保活、前后台 re-arm。

**自身状态**：`idle / connecting / connected / restarting / failed / closed`。

**本轮加法的关键新增字段**：
- **"暂停恢复"闸（`__restartPaused`）+ 代际号（`__restartEpoch`）**：核心。外部喊"暂停"后，已经在 await 链里跑的 ICE restart 步骤（createOffer / setLocalDescription / SDP 交换 / poll）回到检查点时都会比对代际号，发现过期立刻早退
- **resumeRecovery 探针提速**：暂停放开后
  - PC 已经 failed/disconnected → 立刻触发 restart（唯一能穿透暂停闸的 reason 叫 `online_resume`）
  - PC 看着 connected → 主动把"最近活跃时刻"清零、立刻做一次数据探测，把"SCTP 已死但 PC 还没翻"的黑洞从 30-40s 压到 1-3s

**暂停闸下的守卫**：前台事件、常规 restart reason、probe，全部在闸关着时早退；只有 `online_resume` 能穿透。

**向外依赖**：自己做 ICE restart 前会 `await sig.ensureConnected()`——RTC 层自己也知道"WS 不通就先等"。

---

## 3. 每个 claw 的 RPC 通道（ClawConnection）

**职责**：在 DataChannel 上封装 RPC。**本身不参与状态机**——发请求前等 DC 就绪；发现 RTC 已 failed 就反向喊 store"给我重建 RTC"。这是业务层唯一能反向驱动 RTC 的入口。

---

## 4. 协调中心（claws.store）

**最重的一块，也是加法主要发生的地方。**

### 4.1 全局状态（关键三个）

- **`_sigOffline`**：WS 是否不通（connecting 也算不通）。**总闸**。
- **typeChanged 记账 Set**：网络切换事件来了，但此刻某些 claw 没法立刻 restart（WS 没通 / claw 下线 / 处于暂停或 restarting 中）→ **不丢信号，记账**，等暂停放开那一刻消费。
- **"rebuild 后必须刷数据" Set**：只有真的重建 SCTP 时才加入（plugin 侧 DC buffer 丢了），DC 延续场景不刷。

### 4.2 每个 claw 的本地状态

`online`、`rtcPhase`、`dcReady`、未初始化标记、重试计数等。

**严格不变式**：`online` 只走 presence diff 入口写，`dcReady` 只由 RTC 状态机写——其他地方改不动。

### 4.3 监听的外部事件

- **信令 WS 态翻转**：connected ↔ 非 connected → 放开/冻结所有 claw 的恢复逻辑
- **OS 前台恢复、网络 online（带 typeChanged）**
- **服务端推来的 claw 上/下线（或全量快照 diff）**
- **RTC 状态机回调**

### 4.4 五个 gate 点

一次性铺了五处"WS 不通就啥都别干"的闸——进入 `__resumeOnline`、`__ensureRtc`、重试排队、健康探测、处理 network:online 时都先查 `_sigOffline`。

### 4.5 暂停闸放开时的决策树（`__resumeOnline`）

看 PC 当前是啥态 + 记账 Set 是否命中：

| PC 态 | Set 命中 | 动作 |
|-------|----------|------|
| restarting + 暂停 | — | 用 `online_resume` 再踢一次 |
| connected + 暂停 + force 记号 | 是 | triggerRestart |
| connected + 暂停 | 否 | 让 RTC 层自己 resumeRecovery（内部可能再升级成 restart）|
| rtc 为空 / failed / closed | — | 真的 rebuild |

### 4.6 一堆补丁在修什么（过去 10 几轮补强）

- **snapshot 畸形 id 守卫**：防止 null/对象/布尔的 id 进 `syncConnections` 烧 ICE/TURN 预算
- **异步过程中途闸翻转**：建 RTC 要跑几秒，期间闸可能翻转，中途要回查
- **rebuild 刷数据规则简化 + Set 泄漏**：哪些分支要加/删记账条目对齐了好几次
- **restart 被 stale reject 误杀**：connId 按 claw 复用不是按代际，rebuild 后旧的拒绝回执会砸到新 PC，要求必须处于 restarting 态才接受
- **前台恢复时 paused 早退**：暂停着还去发 probe RPC 会白发
- **信令离线时 stranded claw 的补救不要 log storm**：snapshot 发现漏网未初始化 claw 要补跑 `__fullInit`，但 sig 不通时暂缓

---

## 5. 信号怎么串起来（耦合关系图）

### A. OS / 前台信号链

```
浏览器 online / visibilitychange
 → capacitor-app.js 桥成统一 app:foreground / network:online(typeChanged)
 → debounce 1200ms → 三个订阅者各自反应：
    ├─ SignalingConnection：按场景强重连 / 探测
    ├─ WebRtcConnection：re-arm 保活（但暂停着就不 re-arm）
    └─ claws.store.__handleNetworkOnline：先记账（typeChanged），后过 WS 闸
```

### B. WS 翻转是主闸

```
sig 非 connected
 → _sigOffline = true
 → 对所有 claw：清重试窗口 + 喊 RTC 暂停
 → 五个 gate 点全部 return，业务冻结

sig 回到 connected
 → _sigOffline = false
 → 对所有 claw：按未初始化 / 已初始化分派补跑 fullInit 或 __resumeOnline
 → __resumeOnline 根据 PC 态 + 记账 Set 命中，选择 restart / resumeRecovery / rebuild
```

### C. claw presence 翻转（服务端说了算）

```
server 推 claw online: false
 → 仅更新本地状态 + 清重试窗口 + 喊 RTC 暂停（不关 PC）
 → 等 claw 重新 online 或 sig 放开后再恢复
```

---

## 6. 四个关键判定

- **"claw 在线"**：**只看服务端推送**，不看 WS，不看 DC
- **"网络不可用"**：分两层
  - WS 组件层只用 `navigator.onLine` 降噪日志
  - **业务层一概看 `_sigOffline`（= WS 通不通）**
- **WS readyState**：只有底层发送时直接读一次，其它地方一律用封装好的三态
- **navigator.onLine**：业务层不读它，只有 WS 组件自己用

---

## 7. 为什么脆弱感明显（现状观察）

把三路本来正交的状态（信令可达性 / claw 存在性 / RTC 生命周期）通过一把总闸硬耦合后，所有"异步过程跨越闸翻转瞬间"的场景都会冒出新漏洞。十几轮补强几乎全是在补这种**"多个状态源在闸口交汇处的时序漏洞"**：

- 信号消失（暂停态被 drop 的 reason、被忽略的 typeChanged）
- 信号多出来（rebuild 后 stale reject 误杀、Set 条目泄漏在下一轮误消费）
- 中途读到的闸值已过期（`initRtc` 跑完发现闸已经关了）

---

## 讨论议题占位

> 这里留空，每轮讨论后在此记录：当前澄清了什么、修订了哪些理解、还有哪些疑点。

（暂无）
