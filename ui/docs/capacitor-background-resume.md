# Capacitor App 前后台切换与状态恢复策略

> 适用范围：CoClaw UI（Capacitor + WebView 架构）
> 创建时间：2026-03-26

## 目录

1. [问题背景](#1-问题背景)
2. [Android 与 iOS 的具体行为](#2-android-与-ios-的具体行为)
3. [主流解决方案](#3-主流解决方案)
4. [Web 端状态恢复注意事项](#4-web-端状态恢复注意事项)

---

## 1. 问题背景

### Capacitor App 的本质

Capacitor App 的运行架构是：**原生壳（Android Activity / iOS UIViewController）内嵌一个 WebView**，前端代码（HTML/CSS/JS）运行在这个 WebView 中。这意味着：

- 所有 JS 代码、定时器、WebSocket 连接都 **依附于 WebView 的生命周期**
- WebView 的生命周期 **受限于移动操作系统的进程管理策略**

### 核心问题

当用户按下 Home 键、切换到其他 App、或锁屏时，操作系统会将当前 App 切换到"后台"状态。对于 Capacitor App，这会导致：

1. **JS 执行被暂停**：`setTimeout`、`setInterval`、`requestAnimationFrame` 全部停止计时
2. **网络连接可能断开**：WebSocket、EventSource（SSE）等长连接在后台期间可能被系统回收或因 NAT 超时而静默断开
3. **进程可能被终止**：系统内存不足时，后台 App 可能被直接杀死，WebView 中的所有状态丢失

这些行为是操作系统层面的，不是 Capacitor 的 bug，而是 Android/iOS 对后台应用的节能策略。

> **对比桌面环境**：Electron 或浏览器标签页在桌面系统上不受此限制。窗口最小化或失去焦点后，JS 引擎继续正常运行，定时器和网络连接不受影响。macOS 的 App Nap 可能降低不可见窗口的定时器精度，但可通过标记后台活动来禁用。

---

## 2. Android 与 iOS 的具体行为

### 2.1 Android

Android 的后台限制是 **渐进式** 的，不会在切后台的瞬间全部生效：

| 阶段 | 时机 | 对 WebView 的影响 |
|------|------|------------------|
| 刚进后台 | 切换后立即 | JS 执行频率 **降低**（节流），定时器精度下降，但代码仍在运行 |
| 后台约 1~5 分钟 | 因设备和 ROM 而异 | JS 执行被 **暂停**，WebSocket 可能断开 |
| Doze 轻度模式 | 设备静置约 30 分钟 | 网络访问被批量化，仅在系统维护窗口放行 |
| Doze 深度模式 | 设备长时间静置 | 几乎所有后台活动被阻断 |
| OEM 激进策略 | 随时可能 | 小米、华为、OPPO 等厂商的省电策略可能 **直接终止进程** |

**关键特性**：
- Android 提供 **前台 Service** 机制：App 可以启动一个带有常驻通知的后台服务，提升进程优先级，使其几乎不会被系统杀死。但前台 Service 保活的是原生进程，不是 WebView 的 JS 执行
- 没有类似 iOS `beginBackgroundTask` 那样的"保证执行时间窗口"API，但实际上刚进后台的缓冲时间通常比 iOS 更宽裕
- 快速切换（几秒~十几秒内回来）时，JS 通常还在运行，连接完好，用户无感

### 2.2 iOS

iOS 的后台限制更加 **激进且一刀切**：

| 阶段 | 时机 | 对 WKWebView 的影响 |
|------|------|-------------------|
| 刚进后台 | 切换后立即 | JS 继续执行约 **5~10 秒** |
| 挂起（suspend） | 约 5~10 秒后 | JS 执行被 **完全冻结**，所有定时器停止，但进程仍在内存中 |
| 终止（terminate） | 系统内存压力下 | 进程被直接杀死，WebView 所有状态丢失 |

**关键特性**：
- `beginBackgroundTask` API 可申请约 **30 秒**的后台执行窗口，时间到后若未主动结束，系统会直接终止 App（不是挂起，是 kill）
- iOS **不允许**普通 App 真正"常驻后台"，仅导航、音频、VoIP 等特殊类别例外
- JS 被挂起后，回到前台时 **从冻结点恢复执行**——代码中的变量、调用栈都保留，但时间已经跳跃（`Date.now()` 瞬间前进了数分钟甚至数小时）

### 2.3 共同问题

无论平台，以下问题是共性的：

**定时器冻结与时间跳跃**：
后台期间 `setInterval`/`setTimeout` 停止计时。回到前台后定时器恢复，但其计时基准已经偏移。例如一个 25 秒的心跳定时器，在后台待了 5 分钟后，回来时可能立刻触发，但此时的心跳判定逻辑并未考虑这 5 分钟的空白。

**WebSocket 静默断开**：
移动网络的 NAT 表通常 30 秒~5 分钟就会过期。如果 App 在后台超过这个时间，TCP 连接可能已经被中间设备丢弃，但客户端和服务端都不知道。这种"半开连接"状态下：
- 客户端的 `ws.readyState` 仍然是 `OPEN`
- 不会收到 `close` 事件
- 只有在尝试发送数据或 TCP keepalive 超时后才能发现连接已断

**进程被杀后的冷启动**：
系统在内存压力下可能杀死后台 App。用户从任务列表"切回"时，实际上是冷启动——WebView 重新加载，JS 从零开始执行，之前的内存状态全部丢失。

---

## 3. 主流解决方案

### 3.1 原生层保活（Native Background Service）

**思路**：将需要持续运行的逻辑下沉到原生代码中，利用操作系统提供的后台执行能力。

**Android**：
- 启动前台 Service，保持进程存活
- 在 Service 中用原生 WebSocket 客户端（如 OkHttp）维持连接
- 收到消息后存入本地数据库，回到前台时 JS 从数据库读取

**iOS**：
- 申请 Background Modes（如 VoIP push、remote-notification）
- 使用 BGTaskScheduler 注册后台刷新任务（执行时机由系统决定）
- APNs 静默推送可唤醒 App 约 30 秒执行原生代码

**优势**：后台期间也能维持连接和接收数据
**劣势**：
- 需要为 Android/iOS 分别编写原生插件，维护成本高
- iOS 的后台能力非常有限，Apple 审核对滥用 Background Modes 态度严厉
- 架构侵入性大——需要维护两套通信逻辑（原生 + JS）
- 与"选择 Capacitor 就是为了不写原生代码"的初衷矛盾

### 3.2 系统推送通知（FCM / APNs）

**思路**：不尝试在后台保持连接，而是通过操作系统的推送通道通知用户有新消息。

- 服务端检测到客户端离线后，通过 FCM（Android）/ APNs（iOS）发送推送
- 用户看到系统通知 → 点击 → App 回到前台 → 走状态恢复流程

**优势**：用户感知上"没有遗漏消息"
**劣势**：
- 需要服务端集成推送平台
- 推送有延迟，无法保证实时性
- 不解决"回到前台后的状态恢复"问题，只是通知用户去查看

### 3.3 Web 端状态恢复（Graceful Recovery）

**思路**：接受"后台期间连接会断、事件会丢"的现实，将工程重心放在"回到前台后快速恢复到一致状态"上。

- 回到前台时检测连接状态，必要时重连
- 重连后从服务端补拉错过的数据
- 恢复 UI 状态，让用户感知不到中断发生过

**优势**：
- 不需要原生代码，纯 Web 实现
- 同一套逻辑也覆盖桌面浏览器中的网络异常场景
- 维护成本最低，与 Capacitor 的跨平台理念一致

**劣势**：
- 后台期间无法接收实时消息（需配合推送通知弥补）
- 恢复过程有短暂的"数据追赶"阶段

### 3.4 方案对比

| 维度 | 原生层保活 | 系统推送 | Web 端恢复 |
|------|----------|---------|-----------|
| 开发成本 | 高（双平台原生） | 中（服务端集成） | 低（纯 Web） |
| iOS 可行性 | 受限（Apple 审核严格） | 可行 | 可行 |
| 后台实时性 | 高 | 中（有延迟） | 无 |
| 架构侵入性 | 大 | 小 | 小 |
| 桌面端复用 | 不适用 | 不适用 | 直接复用 |

**实践中的选择**：大量 Capacitor/Cordova 类 App 采用 **Web 端恢复 + 系统推送** 的组合。原生保活方案通常只在即时通讯（微信、WhatsApp 级别）的产品中才值得投入。

---

## 4. Web 端状态恢复注意事项

> 本节讨论的注意事项是通用的，不仅限于 Capacitor 移动端场景。桌面浏览器中同样会遇到网络异常、标签页休眠等问题，需要相同的恢复机制。Android/iOS 的特殊性在于**放大了这些问题的频率和严重程度**，并引入了一些移动端特有的问题（如进程被杀）。

### 4.1 连接层恢复

这是所有状态恢复的基础——无论在哪个平台运行，网络连接都可能断开。

#### 4.1.1 断连检测

**被动检测**（适用于所有平台）：
- WebSocket 的 `close` 事件——但仅在连接被"正常关闭"时可靠
- 心跳超时——定期发送 ping，在约定时间内未收到 pong 则判定连接已死
- 发送失败——尝试发送数据时抛出异常

**主动检测**（应对 TCP 静默断开）：
- 记录最后一次收到消息的时间戳（`lastAliveAt`）
- 在需要确认连接状态时（如页面重新可见），用 `Date.now() - lastAliveAt` 判断：
  - 远超心跳周期 → 连接大概率已死，直接断开重连，无需等待心跳超时
  - 在心跳周期内 → 发送一个探测 ping，设置短超时（2~3 秒）确认
  - 刚更新不久 → 连接健康，无需操作

这种基于时间差的判定可以将恢复时间从"等心跳超时的几十秒~几分钟"缩短到"近乎即时"。

#### 4.1.2 重连策略

- **指数退避 + 随机抖动**：避免所有客户端同时重连导致服务端过载
- **前台恢复时的加速重连**：当检测到页面重新可见时，跳过退避等待，立即尝试重连。这是合理的，因为用户正在看着屏幕，期望快速恢复
- **重连上限**：设定最大重连间隔（如 30 秒），避免退避到不可接受的等待时间

#### 4.1.3 心跳与恢复检测的分离

日常心跳的容忍度（允许多次 miss）和恢复时的检测速度是两个不同的需求：

- **日常心跳**需要一定容忍度：网络偶发波动、大数据包传输期间的延迟，都不应触发误判断连。适合较宽松的超时阈值
- **恢复检测**需要快速响应：用户切回 App 后不应等待数十秒才发现连接已断。适合基于时间差的即时判定

这两套逻辑应当独立，互不干扰。

### 4.2 数据层恢复

连接恢复后，需要补齐断连期间错过的数据。

#### 4.2.1 增量同步

- 客户端记录最后已知的数据版本/时间戳/序号
- 重连后向服务端请求"从上次位置到现在的增量"
- 服务端需要支持按位点查询（游标、offset、时间戳等）

#### 4.2.2 全量同步的退路

- 当增量同步不可行时（如断连时间过长、服务端已清理旧数据），退回全量拉取
- 全量同步的代价是性能开销更大，但保证了数据一致性

#### 4.2.3 幂等与去重

- 补拉过程中可能收到重复数据（网络重传、恢复与实时推送重叠等）
- 客户端应按唯一 ID 去重，确保 UI 不出现重复条目

### 4.3 UI 状态恢复

#### 4.3.1 流式输出的断点续传

对于聊天类应用，AI Agent 的回复通常是流式输出的。如果在流式输出过程中发生断连：
- 已经渲染的部分内容保留在 DOM 中（除非组件被卸载）
- 断连期间的流式片段丢失
- 恢复后需要从服务端获取完整的 Agent 回复，替换或补全 UI 中的部分内容

#### 4.3.2 页面内导航导致的状态丢失

即使连接没有断开，页面内的路由切换（如从聊天页跳转到设置页再返回）也可能导致组件卸载和状态丢失。这不是移动端特有的问题，SPA 架构下普遍存在。解决方式通常包括：

- 组件缓存（如 Vue 的 `<KeepAlive>`）
- 状态外置到全局 Store，组件挂载时从 Store 恢复
- 路由级缓存（记住滚动位置等）

#### 4.3.3 用户输入保护

用户在输入框中正在编写的内容不应因为切后台、网络断连或页面切换而丢失。通常的做法是：
- 将输入内容实时持久化到 `localStorage` 或 `sessionStorage`
- 组件挂载时检查并恢复未发送的草稿

### 4.4 移动端特有问题

以下问题在桌面浏览器中不存在或极少发生，是 Android/iOS 环境特有的。

#### 4.4.1 进程被杀后的冷启动恢复

当系统因内存压力杀死 App 进程后，用户从任务列表"切回"时，实际上是 **冷启动**——WebView 从零加载，JS 内存状态全部丢失。此时需要考虑：

- **路由恢复**：记录用户最后所在的路由路径，冷启动后自动导航回去，而非总是回到首页
- **滚动位置恢复**：对于长列表页面（如聊天记录），恢复到之前的滚动位置
- **表单/草稿恢复**：从持久化存储中恢复用户未提交的输入内容

实现方式通常是在 `sessionStorage`（进程被杀后会丢失）或 `localStorage`（持久）中记录这些状态。对于需要跨进程存活的状态，必须使用 `localStorage` 或 IndexedDB。

#### 4.4.2 前台恢复的信号来源

移动端检测"App 回到前台"有两个信号来源：

| 信号 | 来源 | 特点 |
|------|------|------|
| `visibilitychange` | Web 标准 API | 在某些原生场景下（如系统弹窗覆盖后恢复）不一定触发 |
| `appStateChange` | Capacitor 插件 | 依赖原生壳，纯 Web 环境不可用 |

两者应**同时监听，取并集**，并做去重/节流处理，确保恢复逻辑只执行一次。

#### 4.4.3 网络环境切换

移动设备频繁在 WiFi 和蜂窝网络之间切换，每次切换可能导致 IP 地址变化，进而导致：
- TCP 连接断开（但客户端可能不会立即收到 close 事件）
- 需要重新建立 WebSocket 连接

可以监听 `navigator.onLine` 和 `online`/`offline` 事件作为辅助判断。

#### 4.4.4 OEM 省电策略

Android 各厂商（小米 MIUI、华为 EMUI/HarmonyOS、OPPO ColorOS 等）的省电策略差异很大：
- 有些厂商会在用户未主动操作时几十秒内就杀死后台进程
- 部分厂商的"电池优化"白名单机制各不相同
- 这些行为无法在代码层面完全规避，只能尽量做好恢复，并在必要时引导用户将 App 加入电池优化白名单

### 4.5 恢复流程的分级策略

综合以上分析，前台恢复时可以根据 **离开时长** 做分级处理：

| 离开时长 | 判断依据 | 恢复策略 |
|---------|---------|---------|
| 极短（< 心跳周期） | `Date.now() - lastAliveAt` 很小 | 无需恢复，发一个 ping 确认即可 |
| 短暂（心跳周期 ~ 1 分钟） | 最后活跃时间在阈值内 | 发探测 ping，短超时确认；若超时则断开重连 |
| 较长（> 1 分钟） | 最后活跃时间远超阈值 | 假定连接已死，直接断开重连，重连后做增量同步 |
| 进程被杀（冷启动） | 内存状态全部丢失 | 全量初始化，从持久化存储恢复路由和草稿 |

这种分级策略避免了"一刀切"——短暂切出无需任何开销，长时间后台也能快速恢复，进程被杀时有兜底。

---

## 5. 当前架构的前台恢复就绪度评估

> 基于 2026-03-26 完成的阶段一响应式整改后的架构状态。

### 5.1 已经正常工作的恢复链

#### BotConnection 前台恢复（连接层）

`BotConnection.__handleForegroundResume()` 是当前唯一消费 `app:foreground` 事件的模块，实现了三级恢复策略：

| 场景 | 条件 | 行为 |
|------|------|------|
| WS 已断连 | `state === 'disconnected'` | 重置退避到 1s，立即重连 |
| WS 可能死亡 | `elapsed > ASSUME_DEAD_MS`（45s） | `forceReconnect()` |
| WS 存疑 | `elapsed > PROBE_TIMEOUT_MS`（2.5s） | 发 ping 探测，2.5s 无响应则 `forceReconnect()` |
| WS 健康 | `elapsed <= PROBE_TIMEOUT_MS` | 无需操作 |

此设计正确且完善。

#### ChatPage 消息恢复（数据层）

WS 重连后的恢复链：

```
app:foreground
  → BotConnection.__handleForegroundResume()  — 探测/重连 WS
    → conn.on('state', 'connected')
      → botsStore.__bridgeConn → byId[botId].connState = 'connected'
        → botsStore.__onBotConnected(id)
          → if gap >= BRIEF_DISCONNECT_MS: 刷新 agents/sessions/topics stores
        → ChatPage.connReady computed 变为 true
          → connReady watcher
            → chatStore.__reconcileSlashCommand()  — 清理挂起的 slash cmd
            → chatStore.loadMessages({ silent: true })  — 刷新消息
              → agentRunsStore.reconcileAfterLoad()  — 清理 zombie runs
```

这条链路在 WS **确实断连并重连** 的场景下完整且正确。

#### Agent runs reconcile（流式状态恢复）

`reconcileAfterLoad()` 在 `loadMessages` 成功后被调用，通过两个条件检测 zombie runs：
1. 事件流已静默（`lastEventAt` 距今超过 3s）
2. 服务端消息已包含 run 的最终结果（有 terminal `stopReason`）

两个条件同时满足时 settle 该 run。设计正确。

### 5.2 存在的缺陷

#### 缺陷 1：`app:foreground` 事件仅被 BotConnection 消费

**严重度：高**

`setupAppStateChange()`（`utils/capacitor-app.js`）正确桥接了 Capacitor 原生 `appStateChange` 到 `app:foreground` 自定义事件，但**只有 BotConnection 在监听**。以下模块均未监听：

| 模块 | 依赖的恢复信号 | 缺陷 |
|------|-------------|------|
| `use-bot-status-sse.js` | `EventSource` 原生自动重连 | Capacitor 上 `EventSource` 在后台可能被 OS 断开，前台后不一定自动重连 |
| `use-bot-status-poll.js` | `visibilitychange` | Capacitor 上 `visibilitychange` 不一定可靠触发 |

**影响**：前台恢复后 bot 上下线状态可能过期。用户看到离线 bot 显示在线（或反之），直到 SSE/polling 碰巧恢复。

**修复方向**：
- SSE composable：监听 `app:foreground`，强制关闭旧 `EventSource` 并重建。`onopen` 中已有 `botsStore.loadBots()` 全量刷新
- Polling composable：监听 `app:foreground`，触发时立即 `resume()`

#### 缺陷 2：WS 未断连时无恢复路径（短时间后台）

**严重度：高**

如果后台时间较短（几秒~几十秒），WS 可能保持连接（或 probe 判定为健康）。此时：
- `connState` 始终为 `'connected'`，`connReady` 无状态转换
- `connReady` watcher 不触发
- `loadMessages` 不被调用
- `reconcileAfterLoad` 不被调用

**影响**：
- 后台期间若有 agent run 的 `event:agent` 事件丢失（WS 存活但事件在传输链某处丢失，或 WS buffer 被清理），对应 run 会永久卡在 streaming 状态，直到 30min 超时（该超时在后台还可能被冻结）
- 后台期间若有新消息到达（其他设备发送），用户不会看到，直到下次主动刷新

**修复方向**：
- ChatPage 监听 `app:foreground`（或 `visibilitychange`），执行 `loadMessages({ silent: true })`，触发 `reconcileAfterLoad`
- 可复用 `__handleForegroundResume` 的节流逻辑，与 `connReady` watcher 的首次恢复去重

#### 缺陷 3：Draft 使用 `sessionStorage`，不耐进程死亡

**严重度：中**

`draft.store.js` 使用 `sessionStorage` 持久化草稿。`visibilitychange:hidden` 时触发 `persist()`，数据写入 `sessionStorage`。

在 Capacitor 上，OS 杀死 WebView 进程后 `sessionStorage` 随之丢失。用户切走后若 OS 回收内存，返回时正在编辑的消息丢失。

**修复方向**：改用 `localStorage`。改动仅需修改 `sessionStorage` → `localStorage` 和 storage key。`localStorage` 在 Capacitor WebView 中跨进程生命周期持久。

#### 缺陷 4：无 `app:background` 事件

**严重度：中**

`setupAppStateChange()` 在 `isActive === false` 时不发送任何事件。组件无法在进入后台前主动保存状态或记录时间戳。

**修复方向**：补充 `window.dispatchEvent(new CustomEvent('app:background'))`，与 `app:foreground` 对称。可用于：
- Draft store 在后台前主动 persist
- 记录进入后台的时间戳，前台恢复时判断离开时长
- 暂停不必要的定时器

#### 缺陷 5：SSE 无心跳机制

**严重度：低**

`EventSource` 没有应用层心跳。服务端如果不主动发送事件，TCP 半开连接可能长时间不被发现。在 SSE 连接看似存活但实际已断开时，bot 状态事件会被静默丢失。

**影响**：长时间后台后即使 `EventSource` 对象仍存在，实际连接可能已死，但不会触发 `onerror` 重连。

**修复方向**：
- 服务端定期发送 SSE 心跳注释（`:heartbeat\n\n`），客户端无需处理但 `EventSource` 会检测到连接存活
- 或客户端记录最后收到 SSE 事件的时间，前台恢复时若超过阈值则强制重建 `EventSource`
- 此问题优先级低，因为缺陷 1 的修复（`app:foreground` 强制重建 `EventSource`）已经覆盖了主要场景

#### 缺陷 6：WebRTC `disconnected` 状态未在前台恢复时探测

**严重度：低**

`initRtcAndSelectTransport` 在 RTC 为 `disconnected`（ICE 自动恢复中）时不替换它。前台恢复后可能有短暂窗口 RTC 不可用但未降级到 WS。

**影响**：极低。`BotConnection.request()` 已有 DataChannel 可用性检查，不可用时自动降级到 WS。ICE 自动恢复通常在数秒内完成。

### 5.3 修复实施计划

#### 第一优先级（展开前台恢复工作前必须解决）

| 项 | 缺陷 | 改动范围 |
|----|------|---------|
| 1 | SSE + Polling 增加 `app:foreground` 监听 | `use-bot-status-sse.js`、`use-bot-status-poll.js` |
| 2 | ChatPage 增加前台恢复路径（独立于 connReady） | `ChatPage.vue`，可能需提取共享的节流逻辑 |

#### 第二优先级（提升健壮性）

| 项 | 缺陷 | 改动范围 |
|----|------|---------|
| 3 | Draft 改用 `localStorage` | `draft.store.js`（一行改动） |
| 4 | 补充 `app:background` 事件 | `utils/capacitor-app.js` |

#### 后续考虑（可观察后决定）

| 项 | 缺陷 | 备注 |
|----|------|------|
| 5 | SSE 心跳 | 缺陷 1 修复后主要场景已覆盖；可在服务端加 SSE 心跳注释进一步加固 |
| 6 | WebRTC disconnected 探测 | 影响极低，WS fallback 已兜底 |
