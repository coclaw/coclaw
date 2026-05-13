# 远程日志设计

> 范围：Plugin / UI → Server 的诊断日志推送
> 当前形态：Plugin 走 bot WS、UI 走独立 HTTP；HTTP 协议层兼容 plugin 未来切换

---

## 一、背景与动机

OpenClaw 运行在用户的远端环境，Plugin 作为 gateway 扩展运行其中。当遇到连接建立、断开、恢复等问题时，开发者无法直接访问远端日志，排查困难。UI 侧同样缺乏将关键诊断信息集中收集的手段。

### 目标

- Plugin 和 UI 的重要诊断信息推送到 Server，统一通过 Server 日志输出
- Server 作为透传层，不解析日志内容，仅补全连接上下文前缀后落盘
- 各端日志格式由各端自行定义和演化，与 Server 解耦

### UI 通道为何从 RTC signaling WS 迁出

早期 UI 复用 RTC signaling WS 作为日志通道——弱网或网络抖动时，RTC 层优先恢复连接，signaling WS 会频繁重建。WS 重建期间发起的 `remoteLog` 调用全部堆在 UI 内存 buffer 里，等 WS 回到 `connected` 才能 flush。但 RTC 恢复本身耗时数秒甚至更长，正是排障最需要看的窗口。这部分日志在用户关页面 / 切应用前能不能送达，全看运气。

UI 通道因此迁至独立 HTTP 短连接 + 批量上送通道，与 RTC 生命周期解耦。HTTP 短连接每次按需建立，无长连接重建窗口；排障价值最高的"连接恢复中"日志能稳定送达。

### 不限制登录态决策（HTTP 通道）

UI HTTP 通道**不强制登录态**：UI 启动即可上报，登录前 / 登录失败窗口的事件同样能上送 server。理由：

- **排障价值**：登录前事件（JS 启动报错、登录请求失败、i18n 加载失败、capacitor/electron 启动序列异常）正是用户报"登不上"时的关键证据——限制登录后才能上报等于把最需要看的窗口锁掉
- **安全角度**：门控对脚本攻击者的实际门槛接近 0（脚本登录 + cookie 保存几行代码就能绕过），并不构成实质防御；真正的防御层是账号封禁 / 应用层 rate limit / docker log rotation 兜底，跟门控是否存在无关
- **复杂度**：取消门控可删除 UI 端登录态门控、登录后 ring flush、登出 final POST、logoutDraining 状态、epoch 守卫、跨用户 race 处理一整套状态机及其测试

本设计不引入应用层 rate limit、不依赖任何"门控"作为安全层；产品稳定性目标优先，安全防护后续视实际滥用情况再加。

---

## 二、整体方案

```
Plugin ── bot WS ──────────────────► Server ──► logger.info(...)
                                        ▲
UI ──── HTTP POST /api/v1/log/ui ───────┘
        (per-batch, ordered, dedup)
```

- Plugin 通过已有 bot WS 通道发送 `type: 'log'` 消息
- UI 通过独立 HTTP 通道发送批次日志
- 两形态独立演化；服务端入口不同、渲染规则统一

**HTTP 通道是协议层产物，不与特定客户端类型绑定**：协议本身（端点路径、batched POST、客户端身份字段 + seq 单调去重、顺序发送约束）对任何客户端都成立。当前 plugin 走 bot WS 是历史选型，端点路径预留 `/api/v1/log/plugin` 给未来 plugin 切 HTTP；切换时只需替换协议体里的身份字段（如 `uiId` → `pluginInstanceId`），客户端实现模式可以平移。

---

## 三、通用约定

### 单条 entry 格式

```js
{ ts: 1715500000000, text: "ws.connected peer=server rtt=23ms" }
```

- `ts`：毫秒时间戳（`Date.now()`），UTC，无时区歧义
- `text`：可读文本字符串；server 不解析其内容

### Server 日志输出格式

```
2026-03-30T14:02:03.120Z [remote][<source>][<ctx>][ts=<ISO_UTC>] <text>
↑ docker -t：server 接收时刻                                ↑ 客户端事件时刻
```

- `<source>` = `plugin` / `ui`
- `<ctx>` = `claw:<clawId>` / `user:<userId>` / `anon`，按来源 + cookie 状态补全
- `[ts=...]`：由 `fmtRemoteLogTs(ts)` 渲染毫秒时间戳为 ISO UTC；无效输入返回占位 `[ts=??]`
- 两个 ts 都是 UTC，排序时优先用行内 `[ts=...]`（事件发生时刻），docker `-t` 当辅助

### 公共 API

各端均暴露一个全局函数：

```js
remoteLog('ws.connected peer=server rtt=23ms');
```

调用方只需提供纯文本描述；函数内部记录时间戳、组装 entry、推入缓冲区、按各端策略发送。

---

## 四、Plugin 走 bot WS

### 消息格式

```js
{
  type: 'log',
  logs: [
    { ts: 1711774918450, text: 'ws.connected peer=server rtt=23ms' },
    { ts: 1711774919100, text: 'session.restored id=abc dur=1200ms' },
    ...
  ]
}
```

不传 botId / source 等路由信息——Server 从 bot WS 连接上下文获取。

### 客户端发送策略

- 缓冲区上限：**1000 条**（超出时丢弃最旧条目）
- 批量大小：**20 条 / 批**
- 触发时机：
  - 缓冲区积累达到批量大小时
  - 连接可用时 flush 积压日志
- 发送节奏：每发送一批后让出 CPU 一拍，避免阻塞业务消息

连接不可用时日志仅在缓冲区累积，连接恢复后自动 flush。缓冲区满时丢弃最旧条目（保留最新状态）。

### 服务端入口

- claw-ws-hub 的 `type: 'log'` 分支接收
- 上下文补全 `[claw:<clawId>]`，逐条经 `fmtRemoteLogTs` 渲染后 `console.info`

不需要去重——bot WS 是可靠有序传输，缓冲区在 plugin 进程内，重启即丢弃。

---

## 五、HTTP 通道（通用协议形态）

本节描述 HTTP 通道的协议层和服务端实现。当前唯一接入客户端是 UI，协议字段（如 `uiId`）按 UI 命名；未来若 plugin 也接 HTTP，可定义 `pluginInstanceId` 等具体名，服务端为每个 source 分别注册 schema 即可。

### 5.1 协议 schema

请求：

```js
POST /api/v1/log/ui
Cookie: coclaw.sid=...   (可选；浏览器自动带，server 仅用于身份标注)
Body: {
  uiId: "<nanoid, 21 字符>",   // 客户端身份字段；其他客户端类型接入时用各自的名称
  seq: 5,
  logs: [
    { ts: 1715500000000, text: "sig.connected peer=..." },
    ...
  ]
}
```

字段说明：

- 客户端身份字段（`uiId` 等）：客户端实例身份，冷启动生成的 nanoid（默认 21 字符），跨外部事件（如登录态变化）保持不变
- `seq`：该客户端实例下的批次序号，从 1 起、单调递增、跨外部事件不重置
- `logs`：本批次的 log entries，单条结构沿用 §三 通用约定

响应：

| 状态码 | 含义 |
|--------|------|
| 200 | 接受并打印 / 命中去重静默丢弃（对客户端无差异） |
| 400 | 协议字段格式不合法 |
| 405 | 非 POST 方法 |
| 408 / 429 | 客户端应重试，遵循 `Retry-After` |
| 413 | 请求体过大 |
| 5xx | 服务端错误，客户端重试 |

注意：**不返 401**——端点不鉴权，cookie 仅用于身份标注。

**协议字段拆分而非组合 ID 的考量**：早期设计曾用 `batchId: "<clientId>:<seq>"` 组合字符串，但 server 端需要解析后才能用客户端身份做 map key、`seq` 做单调比较——名称对应不直观，schema 校验也要先解析再校验拆解结果。拆为独立字段后，协议层与 server 内部概念直接对应，校验简单、阅读清晰。打印里仍以 `[batch=<身份尾部 8>:<seq>]` 形式呈现"批次"概念，无可读性损失。

### 5.2 顺序发送

客户端维持严格的顺序发送约束：

- 同时**只有 1 个 batch 在 HTTP 请求中**
- 已封批未发的进入待发队列（FIFO）
- 当前 batch ack 后才发下一个

顺序发送是 server 端单调 seq 去重正确性的前提（详见 §5.5）。

### 5.3 重试策略

按响应类型分流：

| 响应 | 处理 |
|------|------|
| 2xx | 成功，从队列移除 |
| 4xx（400 / 403 / 413 等） | 整批丢弃，**不重试**（重试也无用）；端点不返 401 |
| 408 / 429 | 重试，遵循 `Retry-After`（如有，cap 至 30s） |
| 5xx | 重试；若返回 `Retry-After`（503 常见）也解析并 cap 至 30s |
| network error / timeout | 重试 |

退避：固定时间表 `RETRY_DELAYS = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30]`（秒）；首次失败 sleep 第 1 项再发，依次类推。数组本身即唯一数据源，重试次数 = 数组长度，间隔 = 数组项。**不引入随机抖动**——不同客户端实例的首次失败时点天然错开，抖动收益微薄；测试也更确定。

`Retry-After` 上限沿用 `Math.max(RETRY_DELAYS) = 30s`：server 给超过 30s 的值会被压回 30s，避免单 batch 拉过长。

**终止条件**：单 batch 跑完首发 + 10 次重试共 11 次发送即放弃（无墙钟时长闸）。移除墙钟闸的原因：iOS / Android 后台冻结时 `setTimeout` 暂停，前台恢复后从 sleep 断点继续——若卡墙钟会让本来还能发的整批日志立刻被丢；纯按次数计 + 30s cap 已构成上限（数组求和 ~181s，server 持续 503 Retry-After:30 时 10 × 30s = ~300s）。

### 5.4 内存模型（两层）

```
未封批 ring buffer (1000 条上限)
        │
        ▼ 封批触发
已封批待发队列 (10 batch 上限)
        │
        ▼ 顺序发送
    HTTP POST
```

两层独立：重试卡住时新日志仍能正常入 ring，不会被堵死；重试队列满了就丢最旧整批。

**失败窗口容量估算**：worst case 下 server 长期不可达，期间客户端仍以触发条件节奏封批：
- in-flight 1 batch（卡在重试）
- 待发队列 ≤ 10 batch（满了丢最旧整批）
- ring buffer ≤ 1000 条（满了丢最旧 entry）
- **总保留量上限 ≈ 2100 条**，内存占用控制在几百 KB 级别

### 5.5 服务端单调 seq 去重

Server 端维护一个 in-memory map：

```
Map<clientId, { lastSeq, lastSeenAt }>
```

处理收到的 batch：

- 从 body 读客户端身份字段和 `seq`
- 若该身份**不存在则 `lastSeq` 视为 0**——新客户端实例首批 `seq=1 > 0` 自然接受，无需特殊分支
- 若 `seq > lastSeq` → 接受、逐条打印、更新 `lastSeq = seq` 和 `lastSeenAt = now`
- 若 `seq <= lastSeq` → 视为重传，**静默丢弃**（不打印），仍返 200

**为什么单调 seq 而非 LRU**：

- 顺序发送约束（§5.2）保证 seq 严格递增到达（重传除外）
- 状态量从"per-batch"压到"per-client"，更省内存
- server 重启窗口下重复量上限 = 顺序发送下 in-flight batch 数（≤1 batch），远低于 LRU 方案

**状态清理**：1 小时无活动则删除该客户端身份条目；周期定时器扫描（如 5 分钟一次）。客户端身份不持久化、刷新即换；server 端 1h 内即可覆盖绝大多数客户端实例存活期。

### 5.6 单请求上限与 schema 校验

**上限**：

- **100 条 / 1MB body**
- 条数上限与客户端触发条件（100 条）对齐——顺序发送约束下单个 batch 不会超过此量
- byte 上限 1MB 是单条 text 的极端 buffer（正常 100 条约 25KB），远高于实际使用
- 真超限 → server 返 413；客户端遵循 4xx 整批丢弃规则

**Schema 校验**（执行去重 / 打印前的前置校验，违反任一即 400 + 不更新 map）：

| 字段 | 约束 |
|------|------|
| 客户端身份 | 非空字符串；长度等于 nanoid 默认长度（21）；字符集为 nanoid 默认字母表 |
| `seq` | 正整数；落在 JS safe integer 范围内 |
| `logs` | 非空数组；长度 ≤ 单请求上限 |
| `logs[*].ts` | 数值；落在合理时间范围（避免负数 / NaN） |
| `logs[*].text` | 字符串 |

实际溢出风险：单实例顺序发送上限约 0.2 req/s，到达 `2^53` 需约 14 亿年——校验主要防客户端 bug 或恶意调用，不是真实溢出场景。

### 5.7 端点与方法约束

```
POST /api/v1/log/<source>
```

- 路径按 source 分（当前 `/ui`；预留 `/plugin`），便于服务端注册不同的入口处理与上下文补全规则
- **仅接受 POST**；其他方法（GET / PUT / DELETE 等）返 405，在执行任何副作用前先拒绝
- **不强制登录态**：处理流程为 schema 校验 → 单调 seq 去重 → 打印；其中 session cookie 仅用于决定打印身份段（user vs anon），不用于鉴权
- **Origin 校验沿用全局 CORS**：server 已注册全局 CORS 中间件，按 `ALLOWED_ORIGINS` 环境变量 + 硬编码 `capacitor://localhost` + 非生产环境的 `localhost` 维护允许集合。本端点不重复实现 origin 检查

### 5.8 打印格式

```
<docker-ts> [remote][<source>][<ctx>][batch=<身份尾部 8>:<seq>][ts=<ISO_UTC>] <text>
```

- `<ctx>` = 有 session cookie → `[user:<userId>]`；无 session / session 失效 → `[anon]`
- `[batch=...]`：客户端身份尾部 8 字符 + seq，作为短前缀。完整客户端身份由首条 anchor log（如 UI 的 `ui.start`）携带，可双向追溯
- 同一身份流里 `user:xxx` ↔ `anon` 的切换揭示了登录态变化时刻，是有用排障信号

尾部取 8 字符的依据：nanoid 每字符 6 bit，8 字符 = 48 bit 空间，比 GitHub commit prefix（28 bit）还宽，且不易撞普通英文片段，grep 友好。

### 5.9 资源占用估算

- 内存：map 条目 = 活跃客户端实例数 × 几十字节，量级几 MB 以内可控
- CPU：console.info 同步写 stdout，1000 条 / 分钟量级远低于瓶颈
- 网络：HTTP 短连接，HTTP/2 keepalive 复用，单次发送 100 条 ~25KB 原始 / gzip 后 ~5-8KB

---

## 六、UI 端落地

UI 是当前唯一接入 HTTP 通道的客户端。本节描述 UI 在 §5 协议形态上的具体应用决策。

### 6.1 客户端身份字段：`uiId`

UI 端 schema 里身份字段名为 `uiId`：

- **冷启动分配**：UI 实例启动时生成 21 字符 nanoid
- **跨登录态保持**：登录、登出、再登录都不更换；表达的是"UI 实例"而非"用户"
- **不持久化**：刷新页面 / 关闭再打开新 tab 都换新 uiId
- **seq 属于 UI 实例生命周期**：从 1 起单调递增；跨 login / logout 不重置；唯一重置时机是 UI 实例本身重建（刷新页面 / 新 tab）

### 6.2 触发条件（debounce）

| 触发 | 阈值 | 说明 |
|------|------|------|
| 大小 | **100 条** | 攒够 100 条立刻封批 |
| 时间 | **5 秒** | 距上次封批起算；即使没攒够 100 条也封 |

Logout / Login 不在触发列表里——端点不强制登录态，登录动作不影响发送行为（§6.4）。

后台切换 / 进程被杀也不做特殊处理：未发出的 ring/队列内容在 App 切回前台后会按顺序继续发；进程被系统杀掉的话该段日志丢失，下次冷启动用新 uiId 重新开始。本方案排障目标是"看 RTC 连接恢复中那段窗口"，不是"看 App 被杀前最后一刻"，因此不引入 `sendBeacon` / `fetch keepalive` 等绕过浏览器后台节流的手段。

### 6.3 首条 log：`ui.start`

UI 实例冷启动时入队的第一条 log，承载身份 + 环境信息。命名风格与 plugin 端 `coclaw.env` 行保持一致——**默认全称**，仅 `tz` / `net` / `lang` / `ua` 等业界通用缩写保留。

```
ui.start uiId=<nanoid> version=<...> platform=<...> viewport=<...> touch=yes|no
         theme=light|dark|no-pref cores=<n> [mem=<n>] tz=<...> lang=<...> [net=<...>]
         ua="<...>"
```

字段约定：

| 字段 | 来源 | 价值 |
|------|------|------|
| `uiId` | 冷启动生成的 21 字符 nanoid | 完整身份锚点，配合 server 端短前缀使用 |
| `version` | 构建时注入的 UI 版本号 | 排障首要参考 |
| `platform` | `web` / `cap-android` / `cap-ios` / `electron-win` 等 | 平台类型；与 plugin `platform=` 命名风格一致 |
| `viewport` | 视口 + dpr，如 `414x896@3` | 布局类 bug 线索 |
| `touch` | `navigator.maxTouchPoints > 0 ? 'yes' : 'no'` | 触屏诊断；移动端 / 桌面端交互 bug 锚点 |
| `theme` | `prefers-color-scheme` → `light` / `dark` / `no-pref` | 暗色模式 / 主题相关 bug 线索 |
| `cores` | `navigator.hardwareConcurrency` | 性能相关诊断 |
| `mem` | `navigator.deviceMemory`（仅 Chromium 提供，单位 GB） | 性能诊断；不可读时整字段省略 |
| `tz` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | 时区，配合 ts |
| `lang` | `navigator.language` | i18n 类 bug 线索 |
| `net` | `navigator.connection?.effectiveType`（如可读） | 网络类型；不可读时整字段省略（Safari / iOS WebView 普遍不可读，不写 `network=unknown` 以免污染 grep） |
| `ua` | `navigator.userAgent` | 最长，放最后；用引号包 |

可选字段（mem / net）的"取不到就省略"原则统一处理——不写 `unknown` 占位，保持 grep 友好。一个 UI 实例生命周期内只发一次 `ui.start`——它是身份锚点，不重复。

**冷启动时序（建议而非硬约束）**：建议 remote-log 初始化早于 auth 初始化——好处是已登录用户冷启动时第一条日志能直接以 `[user:<userId>]` 标注。即使时序倒置（remote-log 初始化晚于 auth），首条 log 会被标 `[anon]`，后续 log 在 cookie 生效后切回 user，不影响功能正确性。

### 6.4 登录与登出：不做特殊处理

由于端点不强制登录态（§1 / §5.7），UI 端的发送行为**与登录/登出动作完全解耦**：

- UI 冷启动即开始发送循环
- 登录、登出、登录失败、session 过期等事件均**不**触发任何特殊 flush / 状态切换
- `remoteLog()` 调用始终按 §6.2 的 debounce 规则封批、按 §5.2 顺序发送
- HTTP 请求由浏览器自动附带 cookie；登录前 / 登出后 cookie 缺失，server 端打印自动标 `[anon]`；登录期间标 `[user:<userId>]`

**登出时的轻微归属漂移**：登出瞬间 ring 里仍有几条"用户期日志"等着封批；这些 log 真正 POST 上来时 cookie 可能已失效，server 会标为 `[anon]`。**接受这个漂移**——排障时同一 uiId 的日志流里 user → anon 的切换本身就揭示了登出发生的时刻，反而是有用的信号。

**好处**：

- UI 端无需 watch authStore、无需在登录/登出时插入 flush 动作
- 无 logoutDraining 状态、无 epoch 守卫、无 cross-user race 处理
- 整个状态机就是「debounce 入队 → 顺序发送 → 重试」一条直线

---

## 七、推荐记录的事件

各端按需扩展，下表为建议的初始事件清单。

### Plugin 侧

| 事件 | 示例 |
|------|------|
| WS 连接建立/断开 | `ws.connected peer=server` / `ws.disconnected reason=close code=1006` |
| WS 重连 | `ws.reconnecting attempt=3 delay=4000ms` |
| Session 创建/恢复/reset | `session.created id=abc` / `session.reset old=abc new=def` |
| RTC 连接状态变化 | `rtc.state connected→disconnected` |
| Bridge 启动/停止 | `bridge.started` / `bridge.stopped reason=unbound` |
| 关键错误 | `error.transport msg="connection refused"` |

### UI 侧

| 事件 | 示例 |
|------|------|
| 启动锚点 | `ui.start uiId=<...> version=<...> platform=<...> ua="<...>"`（每个 UI 实例只发一次） |
| SSE 连接/断开/重连 | `sse.connected` / `sse.reconnecting attempt=2` |
| RTC signaling WS 连接/断开 | `sigws.connected` / `sigws.disconnected code=1006` |
| RTC PeerConnection 状态变化 | `rtc.state bot=abc connected→failed` |
| DataChannel 开启/关闭 | `dc.open bot=abc` / `dc.closed bot=abc` |

---

## 八、边角情况与权衡

### 8.1 Server 重启 → 去重状态丢失

**场景**：server 部署重启，in-memory map 清空；客户端有 in-flight batch 在重传 → 新 server 不认识该客户端身份 → 当新数据接受 → 重复打印。

**重复量分析**：

- 顺序发送约束下，客户端同时只有 1 个 batch 在飞
- server 重启窗口内最多重传 1 个 batch
- 即每次 server 重启理论上最多产生 1 个 batch 的重复

**处理策略**：

- **接受少量重复**——业界通行做法（Sentry / Datadog 等都不为日志做强幂等）
- **batch 打印短前缀让重复可识别**：`[batch=<身份尾部 8>:<seq>]` 字段让肉眼 / grep 一眼看出"同 batch 出现两次 = 重传重复"

### 8.2 跨登录态的日志归属（UI HTTP 通道）

由于 UI 发送行为与登录态解耦（§6.4），同一 UI 实例的 log 流可能跨越 anon / user 多个阶段：

- 启动期：cookie 缺失 → `[anon]`
- 登录后：cookie 生效 → `[user:<userId>]`
- 登出后：cookie 失效 → `[anon]`
- 再登录：cookie 重新生效 → `[user:<userId>]` 或 `[user:<另一 userId>]`

`uiId` 在整个 UI 实例生命周期保持不变，**所有这些阶段的 log 都按同一 uiId 单调 seq 去重**，互不干扰。同一 uiId 内身份段的切换本身揭示了登录态变化时刻，**是有用的排障信号，不是 bug**。

**其他边界场景**：

- **多 tab**：每个 tab 独立 uiId、独立 seq；server 端 map 按身份分桶，互不干扰
- **页面水化前的早期 log**：按入队时刻的 cookie 状态判定；功能正确性不依赖 UI 框架水化完成
- **session 过期但 cookie 仍在**：server 端按 cookie + session 当时有效性综合判定（cookie 存在但 session 已过期 → 仍标 `[anon]`）

### 8.3 多 server 实例（集群部署）

CoClaw 当前为**单实例部署**。如果未来水平扩展为多实例：

- 去重 map per-pod，同一客户端身份的不同 batch 可能落到不同 pod → 各自独立 → 重复打印
- 缓解方向（未来）：负载均衡 sticky by clientId / 共享存储（Redis）/ 接受重复

本设计不为集群做预设计，单实例假设记入文档供未来追溯。

### 8.4 CSRF 与滥用面（HTTP 通道）

端点不强制登录态意味着任何能访问 server 的请求都能产生日志记录。本节梳理实际威胁面与对策：

**威胁 1：XSS / 跨站脚本利用浏览器发请求**
- SameSite=Lax cookie 已存在但本端点不依赖鉴权，不构成此层防御
- **靠 server 全局 CORS 挡浏览器侧攻击**：允许 origin 集合在中间件层统一管理，本端点不重复实现 origin 检查

**威胁 2：脚本主动灌包**（curl / postman / 自写 client）
- Origin 可被伪造，CORS 挡不住非浏览器客户端
- 实际伤害：server stdout 多出垃圾日志，单批上限（100 条 / 1MB）约束单次量级
- **真正可见的负面影响不是磁盘爆满，而是垃圾日志把有用诊断日志在 rotation 滚走前挤掉**——磁盘容量被 docker log rotation 兜住，但有用日志会被噪声淹没/排出窗口
- 兜底机制：docker `json-file` driver 配 `max-size: 10m × max-file: 10`，单 container 约 100MB 滚动容量
- **应用层不防御**（不做 rate limit）——本次目标是稳定产品；真发生滥用 → 运维层封禁源 IP / 临时下线端点 / 调大 rotation 容量

**威胁 3：恶意账号灌包**（已登录用户滥用）
- 与威胁 2 同质——能登录的用户在 user 模式下，能脚本的用户在 anon 模式下，攻击成本几乎一样
- 处置同上：账号封禁 / 运维层兜底

总结：**不做 CSRF token，不做 rate limit**。本次目标稳定产品（用排障日志），安全防护后续视实际情况再加。

---

## 九、过渡与回滚

### 9.1 UI 通道从 signaling WS 切到 HTTP

- UI 端**直接切**到 HTTP 通道，不双写
- UI 是 PWA / Capacitor 内嵌 webview，发版时同步更新，无"老 UI 仍在野"场景
- Plugin 不动，维持 bot WS 通道

### 9.2 回滚安全网

- **仅 RTC signaling WS 上的 UI log 接收分支**保留 4 周作为死代码——这期间如果 HTTP 方案出严重问题，可以紧急回滚 UI 改动
- ⚠️ **不波及 plugin 的 bot WS log 通道**：plugin → server 的 `type: 'log'` 在 bot WS 上仍是生产路径；4 周后清理 UI 分支时务必只删 signaling WS 那一处，不要误删 bot WS 的同名分支
- 4 周观察期无问题后，下一个稳定版本删除 server 端的 RTC signaling WS UI log 分支

### 9.3 未来 plugin 切 HTTP 的接入口

如果 plugin → server 也想从 bot WS log 通道切到 HTTP：

- **服务端**：新增 `/api/v1/log/plugin` 路由，复用 §5 的 schema / 去重 / 打印基础设施，仅替换上下文补全（`[claw:<clawId>]` 由 cookie 之外的认证机制提供，如 plugin 的注册 token / bot WS handshake 阶段产物）
- **客户端**：plugin 端实现可基本平移 UI 的 ring buffer + pending 队列 + 顺序发送 + 重试数组，仅替换发送代码（axios HTTP）和身份字段名

本设计为这种切换预留口子，但**不主动实施**——bot WS 通道当前稳定，无切换动机；未来若有诉求再单独立项。

---

## 十、安全与隐私

- **不强制登录态**（HTTP 通道）：端点接受 anon 上报；身份用于打印标注（`[user:xxx]` / `[anon]`），不用于鉴权
- **Origin 校验由全局 CORS 提供**：本端点不重复实现 origin 检查，沿用 server 中间件统一配置
- **不传输内容/凭据**：log text 只承载连接元数据、状态机事件、错误码等诊断信息；调用方负责确保不写入 token、cookie、消息正文等敏感数据
- **不持久化**：server 端只打印到 stdout（依赖现有日志基础设施），不存盘、不入库
- **不解析内容**：server 端 text 字段透传，不做模式匹配 / 解析
- **不做 rate limit**：本次目标稳定产品，安全防护后续视实际情况再加；滥用兜底由 docker log rotation + 运维层处置承担（详见 §8.4 威胁分析）

---

## 十一、不在本设计范围

- **Plugin → Server log 通道切 HTTP**（继续走 bot WS；§9.3 留有接入口）
- 服务端 metrics（命中率、payload 分布等）
- 服务端 rate limit
- 多 server 实例集群下的共享去重
- 日志持久化 / 聚合 / 检索
- CSRF token / 应用层身份认证（端点不鉴权，origin 校验沿用全局 CORS）
- 滥用监测与自动封禁（依赖运维层兜底）

---

## 十二、决策摘要

| # | 决策 | 选择 | 主要理由 |
|---|------|------|---------|
| 1 | UI 协议形态 | HTTP POST 短连接 + 批量 | RTC signaling WS 弱网频繁重建 → 关键窗口日志丢；HTTP 短连接每次按需建立 |
| 2 | Plugin 协议形态 | 维持 bot WS | bot WS 已稳定，无切换动机；HTTP 通道留接入口 |
| 3 | HTTP 端点路径 | `/api/v1/log/<source>`（当前 `/ui`，预留 `/plugin`） | 路径按 source 区分，扩展友好 |
| 4 | HTTP 方法 | POST only，其他方法 405 | 减小攻击面；浏览器侧跨站防御由全局 CORS 提供 |
| 5 | HTTP 登录态门控 | **不限制**——anon 也能上报，cookie 仅用于身份标注 | 登录前事件是排障关键证据；门控对脚本攻击者门槛接近 0，无实质防御价值；客户端状态机大幅简化 |
| 6 | 客户端身份字段 | 冷启动分配 21 字符 nanoid（UI 命名为 `uiId`） | 全球唯一，跨用户不撞；跨登录态保持以便排障追溯 |
| 7 | seq 生命周期 | 属于客户端实例，跨外部事件不重置 | 简化客户端状态机；同实例下身份切换不影响去重 |
| 8 | 协议字段拆分 | body 显式 `{ <身份>, seq, logs }` 三字段 | 避免组合 ID 与 server 内部 lastSeq 概念不对应 |
| 9 | 打印短标识 | 客户端身份尾部 8 字符 | 比 GitHub commit prefix 还宽，grep 友好 |
| 10 | 身份段渲染 | 有 session → `[user:<userId>]`；无 session → `[anon]` | 同实例下 user / anon 切换揭示登录态变化时刻 |
| 11 | 字段命名风格 | 默认全称，仅 `tz` / `net` / `lang` / `ua` 等业界惯例缩写保留 | 与 plugin `coclaw.env` 风格一致 |
| 12 | UI Debounce | 100 条 / 5 秒 | 业界主流量级；UI 日志量不大；后台切换/进程被杀不做特殊处理 |
| 13 | 顺序发送 | 同时 1 batch in-flight | 单调 seq 去重的前提；把 server 重启重复量压到 ≤1 |
| 14 | 去重方式 | 单调 seq | 状态量小、实现简单、配合顺序发送精确度高 |
| 15 | Server map 默认值 | 身份不存在时 lastSeq 视为 0 | 新实例首批 seq=1 自然接受，无特殊分支 |
| 16 | Schema 校验 | 进入去重/打印前必校验，违反 400 不更新 map | 防客户端 bug / 恶意客户端污染 map |
| 17 | 单请求上限 | 100 条 / 1MB | 与客户端 debounce 阈值对齐 |
| 18 | 重试上限 | 数组驱动：10 次重试 + 30s cap（无墙钟闸） | 后台冻结/恢复语义友好；总时长由数组+cap 推出 |
| 19 | 重试队列容量 | 10 batch | 超容丢最旧整批 |
| 20 | Server 重启重复 | 接受少量重复 | 业界通行；batch 打印短前缀让重复可识别 |
| 21 | UI Logout 处理 | **不做特殊处理**；正常 debounce / 顺序发送继续 | 接受 logout 瞬间 ring 里"用户期"日志被标 anon 的轻微归属漂移 |
| 22 | Origin 校验 | 沿用 server 全局 CORS，端点不重复实现 | 全局 CORS 已含 coclaw.net 系 + `capacitor://localhost` 等合法来源 |
| 23 | 限流 / CSRF token | 不做 | 本次目标稳定产品；安全防护后续视情况再加 |
| 24 | UI 切换过渡 | 直接切，不双写 | UI 同步发版，无野生老 UI |
| 25 | 回滚安全网 | RTC signaling WS 上的 UI log 分支保留 4 周死代码（不波及 plugin bot WS） | 紧急回退用 |
