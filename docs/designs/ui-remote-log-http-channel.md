# UI 远程日志 HTTP 通道设计

> 创建时间：2026-05-12
> 状态：已实施（2026-05-12）
> 范围：UI → Server 的诊断日志推送，从 RTC signaling WS 迁移到独立 HTTP 通道；plugin → Server 维持 bot WS 不变

---

## 一、背景与动机

### 现状

UI 的 `remoteLog` 复用 RTC signaling WS（参见 [remote-log-channel.md](./remote-log-channel.md)），server 在 `type: 'log'` 分支接收。已实施且运行良好。

### 痛点

**关键诊断窗口的日志大概率丢**：弱网或网络抖动时，RTC 层优先恢复连接，signaling WS 会频繁重建。WS 重建期间发起的 `remoteLog` 调用全部堆在 UI 内存 buffer 里，等 WS 回到 `connected` 才能 flush——但 RTC 恢复本身耗时数秒甚至更长，正是排障最需要看的窗口。这部分日志在用户关页面 / 切应用前能不能送达，全看运气。

### 目标

- UI 日志通过独立 HTTP 通道上送，与 RTC 生命周期解耦
- RTC signaling WS 出问题时，HTTP 日志通道仍可独立工作（HTTP 短连接每次按需建立，无长连接重建窗口）
- 排障价值最高的"连接恢复中"日志能稳定送达

### 范围限定

- **仅 UI 通道**改造；plugin → server 维持 bot WS 通道不变（plugin 通道一直稳定，无 RTC 重建窗口）
- **不限制登录态**：UI 启动即可上报，登录前 / 登录失败窗口的事件同样能上送 server——这是相对现状（仅登录用户可上报）的**有意放宽**

### 关于"是否限制登录用户上报"的决策

现状是仅登录用户能 remoteLog（信令 WS 强制 session 认证）。本次设计**主动取消此限制**，理由：

- **排障价值角度**：登录前事件（JS 启动报错、登录请求失败、i18n 加载失败、capacitor/electron 启动序列异常）正是用户报"登不上"时的关键证据——限制登录后才能上报等于把最需要看的窗口锁掉
- **安全角度**：门控对脚本攻击者的实际门槛接近 0（脚本登录 + cookie 保存几行代码就能绕过），并不构成实质防御；真正的防御层是账号封禁 / 应用层 rate limit / docker log rotation 兜底，跟门控是否存在无关
- **复杂度角度**：取消门控可删除 UI 端登录态门控、登录后 ring flush、登出 final POST、logoutDraining 状态、epoch 守卫、跨用户 race 处理一整套状态机及其测试

本次不引入应用层 rate limit、不依赖任何"门控"作为安全层；产品稳定性目标优先，安全防护后续视实际滥用情况再加。

---

## 二、整体方案

### 通道形态

```
UI ──── HTTP POST /api/v1/log/ui ────► Server ──► console.info(...)
        (cookie 可选；用于身份标注，不用于鉴权)
```

- 每个 HTTP POST 发送一个 batch（一批 log entries）
- Server 端去重 + 渲染 + 输出，沿用现有渲染规则（`[ts=<ISO_UTC>]` 字段）
- 不双写、不保留 WS log 通道作 fallback（直接切）
- 端点**不强制认证**——有 session cookie 则打印标 `[user:<userId>]`，否则标 `[anon]`

### 协议 schema

请求：

```js
POST /api/v1/log/ui
Cookie: coclaw.sid=...   (可选；浏览器会自动带，server 只用于身份标注)
Body: {
  uiId: "<nanoid, 21 字符>",
  seq: 5,
  logs: [
    { ts: 1715500000000, text: "sig.connected peer=..." },
    { ts: 1715500001234, text: "rtc.state connecting" },
    ...
  ]
}
```

字段说明：

- `uiId`：UI 实例身份，冷启动生成的 nanoid（默认 21 字符），跨登录态保持不变
- `seq`：该 uiId 下的批次序号，从 1 起、单调递增、跨 login/logout 不重置
- `logs`：本批次的 log entries，结构沿用 `{ ts, text }`

响应：

```
200 OK   — 接受并打印 / 命中去重静默丢弃（对客户端无差异）
400      — 协议字段格式不合法（详见 §4.4 schema 校验）
405      — 非 POST 方法
413      — 请求体过大
4xx/5xx  — 其他错误
```

注意：**不返 401**——端点不鉴权，cookie 仅用于身份标注。

### 与现有 WS 协议的关系

| 字段 | WS 现状 | HTTP 新协议 | 差异 |
|------|---------|------------|------|
| `logs[*].ts` | ms 时间戳 | 同 | 无变化 |
| `logs[*].text` | 字符串 | 同 | 无变化 |
| `type` | `'log'` | 不存在 | HTTP 端点本身表达语义 |
| `uiId` | 不存在（WS 上下文含用户身份但不含实例身份） | 显式字段 | 新增；用于跨 batch 关联同一 UI 实例 |
| `seq` | 不存在 | 显式字段 | 新增；server 据此单调去重 |

**协议拆字段而非组合 ID 的考量**：早期设计曾用 `batchId: "<uiId>:<seq>"` 组合字符串，但 server 端需要解析后才能用 `uiId` 做 map key、`seq` 做单调比较——名称对应不直观，schema 校验也要先解析再校验拆解结果。改为独立字段后，协议层与 server 内部概念直接对应，校验简单、阅读清晰。日志打印里仍以 `[batch=<uiId 尾部 8>:<seq>]` 形式呈现"批次"概念，无可读性损失。

**协议层迁移成本极小**：每条 log entry 结构完全沿用，server 端 log 打印代码可直接复用。

---

## 三、客户端设计

### 3.1 uiId 与 seq

- **uiId 冷启动时分配**：UI 实例启动时生成 nanoid（默认 21 字符），作为该 tab 的身份标识
- **uiId 跨登录态保持不变**：登录、登出、再登录都不更换；表达的是"UI 实例"而非"用户"
- **uiId 不持久化**：刷新页面 / 关闭再打开新 tab 都换新 uiId
- **seq 属于 UI 实例生命周期**：从 1 起单调递增；**跨 login / logout 不重置**；唯一重置时机是 UI 实例本身重建（刷新页面 / 新 tab）

### 3.2 触发条件（debounce）

| 触发 | 阈值 | 说明 |
|------|------|------|
| 大小 | **100 条** | 攒够 100 条立刻封批 |
| 时间 | **5 秒** | 距上次封批起算；即使没攒够 100 条也封 |

Logout / Login 不在触发列表里——端点不强制登录态，登录动作不影响发送行为（详见 §3.6）。

后台切换 / 进程被杀也不做特殊处理：未发出的 ring/队列内容在 App 切回前台后会按顺序继续发；进程被系统杀掉的话该段日志丢失，下次冷启动用新 uiId 重新开始。本方案的排障目标是"看 RTC 连接恢复中那段窗口"，不是"看 App 被杀前最后一刻"，因此不引入 `sendBeacon` / `fetch keepalive` 等绕过浏览器后台节流的手段。

这两个常量先写死，后续可演化为外部可配。

### 3.3 顺序发送（同时只有 1 个 batch 在飞）

UI 端维持严格的顺序发送约束：

- 同时**只有 1 个 batch 在 HTTP 请求中**
- 已封批未发的进入待发队列（FIFO）
- 当前 batch ack 后才发下一个
- 待发队列容量上限 **10 个 batch**，超容丢最旧的整批

顺序发送是 server 端单调 seq 去重正确性的前提（详见 §4.2）。

### 3.4 重试策略

按响应类型分流：

| 响应 | 处理 |
|------|------|
| 2xx | 成功，从队列移除 |
| 4xx (400/403/413 等) | 整批丢弃，**不重试**（重试也无用）；端点不返 401 |
| 408 / 429 | 重试，遵循 `Retry-After`（如有，cap 至 30s） |
| 5xx | 重试；若返回 `Retry-After`（503 常见）也解析并 cap 至 30s |
| network error / timeout | 重试 |

退避：固定时间表 `RETRY_DELAYS = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30]`（秒）；首次失败 sleep 第 1 项再发，依次类推。数组本身即唯一数据源，重试次数 = 数组长度，间隔 = 数组项。**不引入随机抖动**——remote-log 不同 UI 实例的首次失败时点天然错开，抖动收益微薄；测试也更确定。

`Retry-After` 上限沿用 `Math.max(RETRY_DELAYS) = 30s`：server 给超过 30s 的值会被压回 30s，避免单 batch 拉过长。

终止条件：**单 batch 跑完首发 + 10 次重试共 11 次发送即放弃**（无墙钟时长闸）。删除墙钟闸的原因：iOS/Android 后台冻结时 `setTimeout` 暂停，前台恢复后从 sleep 断点继续——若卡墙钟会让本来还能发的整批日志立刻被丢；纯按次数计 + 30s cap 已构成上限（数组求和 ~181s，server 持续 503 Retry-After:30 时 10 × 30s = ~300s，与原 10min 墙钟闸量级相近）。

**失败窗口容量估算**：worst case 下 server 长期不可达，期间 UI 仍以 5 秒 / 100 条节奏封批：
- in-flight 1 batch（卡在重试）
- 待发队列 ≤ 10 batch（满了丢最旧整批）
- ring buffer ≤ 1000 条（满了丢最旧 entry）
- **总保留量上限 ≈ 2100 条**，内存占用控制在几百 KB 级别

### 3.5 内存模型（两层）

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

### 3.6 登录与登出：不做特殊处理

由于端点不强制登录态（§2 / §4.1），UI 端的发送行为**与登录/登出动作完全解耦**：

- UI 冷启动即开始发送循环
- 登录、登出、登录失败、session 过期等事件均**不**触发任何特殊 flush / 状态切换
- `remoteLog()` 调用始终按 §3.2 的 debounce 规则封批、按 §3.3 顺序发送
- HTTP 请求由浏览器自动附带 cookie；登录前 / 登出后 cookie 缺失，server 端打印自动标 `[anon]`；登录期间标 `[user:<userId>]`

**登出时的轻微归属漂移**：登出瞬间 ring 里仍有几条"用户期日志"等着封批；这些 log 真正 POST 上来时 cookie 可能已失效，server 会标为 `[anon]`。**接受这个漂移**——排障时同一 uiId 的日志流里 user → anon 的切换本身就揭示了登出发生的时刻，反而是有用的信号。

**好处**：

- UI 端无需 watch authStore、无需在登录/登出时插入 flush 动作
- 无 logoutDraining 状态、无 epoch 守卫、无 cross-user race 处理
- 整个状态机就是「debounce 入队 → 顺序发送 → 重试」一条直线，逻辑量比限制登录态的方案少一半左右

### 3.7 首条 log：`ui.start`

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
| `cores` | `navigator.hardwareConcurrency` | 性能相关诊断；与 plugin `cores=` 一致 |
| `mem` | `navigator.deviceMemory`（仅 Chromium 提供，单位 GB） | 性能诊断；不可读时整字段省略 |
| `tz` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | 时区，配合 ts |
| `lang` | `navigator.language` | i18n 类 bug 线索 |
| `net` | `navigator.connection?.effectiveType`（如可读） | 网络类型；不可读时整字段省略（Safari / iOS WebView 普遍不可读，不写 `network=unknown` 以免污染 grep） |
| `ua` | `navigator.userAgent` | 最长，放最后；用引号包 |

可选字段（mem / net）的"取不到就省略"原则统一处理——不写 `unknown` 占位，保持 grep 友好。

一个 UI 实例生命周期内只发一次 `ui.start`——它是身份锚点，不重复。

UI 冷启动即开始发送，`ui.start` 通常在登录前就能 POST 到 server（标 `[anon]`），用户登录后续 log 自动切换为 `[user:<userId>]`。

**冷启动时序（建议而非硬约束）**：建议 remote-log 初始化早于 auth 初始化——好处是已登录用户冷启动时第一条日志能直接以 `[user:<userId>]` 标注。即使时序倒置（remote-log 初始化晚于 auth），首条 log 会被标 `[anon]`，后续 log 在 cookie 生效后切回 user，不影响功能正确性。登录前事件本身在 CoClaw 当前实现里很少需要 remote log（登录流程已经较为可靠），所以这里不当作硬约束。

**实施 TODO**：本设计假设构建时已经把 UI 版本号注入到运行时常量（如 `__APP_VERSION__`）。若 Vite 配置尚未做此注入，实施任务里需要补；如取不到 version 字段，按 `version=unknown` 输出。

---

## 四、服务端设计

### 4.1 端点

```
POST /api/v1/log/ui
```

- 路径预留 `/ui` 后缀是给未来 plugin 切 HTTP 留口子（`/api/v1/log/plugin`），本次不接
- **仅接受 POST**；其他方法（GET / PUT / DELETE 等）返 405，在执行任何副作用前先拒绝
- **不强制登录态**：处理流程为 schema 校验 → 单调 seq 去重 → 打印；其中 session cookie 仅用于决定打印身份段（user vs anon），不用于鉴权
- **Origin 校验沿用全局 CORS**：server `app.js` 中已注册全局 CORS 中间件，按 `ALLOWED_ORIGINS` 环境变量 + 硬编码 `capacitor://localhost` + 非生产环境的 `localhost` 维护允许集合。本端点不重复实现 origin 检查；未来引入新 Capacitor scheme 或新域名只需在环境变量里加项，与本端点无关

### 4.2 单调 seq 去重

Server 端维护一个 in-memory map：

```
Map<uiId, { lastSeq, lastSeenAt }>
```

处理收到的 batch：

- 从 body 读 `uiId` 和 `seq`（已是独立字段，无需解析）
- 查 map：若 uiId **不存在则 `lastSeq` 视为 0**——新 UI 实例首批 `seq=1 > 0` 自然接受，无需特殊分支
- 若 `seq > lastSeq` → 接受、逐条打印、更新 `lastSeq = seq` 和 `lastSeenAt = now`
- 若 `seq <= lastSeq` → 视为重传，**静默丢弃**（不打印），仍返 200

**为什么单调 seq 而非 LRU**：

- UI 端顺序发送（§3.3）保证 seq 严格递增到达（重传除外）
- 状态量从"per-batch"压到"per-uiId"，更省内存
- server 重启窗口下重复量上限 = 顺序发送下 in-flight batch 数（≤1 batch），远低于 LRU 方案

### 4.3 状态清理

- TTL：**1 小时无活动则删除**该 uiId 条目
- 实现方式：单一周期定时器扫描清理（如每 5 分钟扫一次）
- UI 端 uiId 不持久化，刷新即换；server 端 1h 内即可覆盖绝大多数 UI 实例存活期

### 4.4 单请求上限与 schema 校验

**上限**：

- **100 条 / 1MB body**
- 条数上限与客户端 debounce 阈值（100 条）对齐——顺序发送约束下单个 batch 不会超过此量；不存在"logout final flush 合并多 batch"等需要放宽的场景
- byte 上限 1MB 是单条 text 的极端 buffer（正常 100 条约 25KB），远高于实际使用
- 真超限（UI bug 或恶意客户端）→ server 返 413；UI 端遵循 4xx 整批丢弃规则

**Schema 校验**（执行去重 / 打印前的前置校验，违反任一即 400 + 不更新 map）：

| 字段 | 约束 |
|------|------|
| `uiId` | 非空字符串；长度等于 nanoid 默认长度（21）；字符集为 nanoid 默认字母表 |
| `seq` | 正整数；落在 JS safe integer 范围内（`<= Number.MAX_SAFE_INTEGER`） |
| `logs` | 非空数组；长度 ≤ 单请求上限 |
| `logs[*].ts` | 数值；落在合理时间范围（避免负数 / NaN） |
| `logs[*].text` | 字符串 |

实际溢出风险：单 UI 实例顺序发送上限约 0.2 req/s，到达 `2^53` 需约 14 亿年——校验主要防 UI bug 或恶意客户端，不是真实溢出场景。

### 4.5 打印格式

```
2026-05-12T08:26:16.447Z [remote][ui][user:<userId>|anon][batch=<尾部 8 字符>:<seq>][ts=<ISO_UTC>] <text>
```

- 时间戳前缀（docker `-t`）= server 接收时刻
- 身份段：
  - 请求带有效 session cookie → `[user:<userId>]`（沿用现有约定，与 plugin 通道的 `[remote][plugin][claw:xxx]` 平行）
  - 无 session / session 失效 → `[anon]`
  - 同一 uiId 的日志流里 `user:xxx` → `anon` 的切换揭示了登出时刻，是有用排障信号
- `[batch=...:N]` = 新增，**uiId 取尾部 8 字符**作为短标识；配合 `ui.start` 中的完整 uiId 可双向追溯
- `[ts=...]` = 沿用现有 `fmtRemoteLogTs` 渲染（参见 [remote-log-channel.md](./remote-log-channel.md)）

uiId 尾部取 8 字符的依据：nanoid 每字符 6 bit，8 字符 = 48 bit 空间，比 GitHub commit prefix (28 bit) 还宽，且不易撞普通英文片段，grep 友好。

### 4.6 资源占用估算

- 内存：map 条目 = 活跃 UI 实例数 × 几十字节，量级几 MB 以内可控
- CPU：console.info 同步写 stdout，1000 条 / 分钟量级远低于瓶颈
- 网络：HTTP 短连接，HTTP/2 keepalive 复用，单次发送 100 条 ~25KB 原始 / gzip 后 ~5-8KB

---

## 五、边角情况与权衡

### 5.1 Server 重启 → 去重状态丢失

**场景**：server 部署重启，in-memory map 清空；UI 端有 in-flight batch 在重传 → 新 server 不认识 uiId → 当新数据接受 → 重复打印。

**重复量分析**：

- 顺序发送约束下，UI 端同时只有 1 个 batch 在飞
- server 重启窗口内最多重传 1 个 batch
- 即每次 server 重启理论上最多产生 1 个 batch 的重复

**处理策略**：

- **接受少量重复**——这是业界通行做法（Sentry / Datadog 等都不为日志做强幂等）
- **batch 打印短前缀让重复可识别**：server 打印里的 `[batch=<uiId 尾部 8>:<seq>]` 字段让肉眼 / grep 一眼看出"同 batch 出现两次 = 重传重复"

### 5.2 跨登录态的日志归属

由于 UI 发送行为与登录态解耦（§3.6），同一 UI 实例的 log 流可能跨越 anon / user 多个阶段：

- 启动期：cookie 缺失 → `[anon]`
- 登录后：cookie 生效 → `[user:<userId>]`
- 登出后：cookie 失效 → `[anon]`
- 再登录：cookie 重新生效 → `[user:<userId>]` 或 `[user:<另一 userId>]`

`uiId` 在整个 UI 实例生命周期保持不变，**所有这些阶段的 log 都按同一 uiId 单调 seq 去重**，互不干扰。同一 uiId 内身份段的切换本身揭示了登录态变化时刻，**是有用的排障信号，不是 bug**。

**关于 logout 瞬间 ring 里的"用户期"日志**：登出瞬间 ring 里通常有几条尚未封批的 log（产生于登录态期间）。这些 log 真正 POST 到 server 时 cookie 可能已经失效，server 标 `[anon]`——**轻微归属漂移，可接受**。如果排障真需要精确归属，从 `ui.start` + 时间线 + cookie 切换点就能反推出归属，不损失信息。

**其他边界场景**：

- **多 tab**：每个 tab 独立 uiId、独立 seq；server 端 map 按 uiId 分桶，互不干扰
- **页面水化前的早期 log**：按 ui.start 入队时刻的 cookie 状态判定；功能正确性不依赖 UI 框架水化完成
- **session 过期但 cookie 仍在**：server 端按 cookie + session 当时有效性综合判定（cookie 存在但 session 已过期 → 仍标 `[anon]`）

这些场景下 remote log 功能行为完全一致，UI 端无需感知。

### 5.3 多 server 实例（集群部署）

CoClaw 当前为**单实例部署**。如果未来水平扩展为多实例：

- 去重 map per-pod，同 uiId 的不同 batch 可能落到不同 pod → 各自独立 → 重复打印
- 缓解方向（未来）：负载均衡 sticky by uiId / 共享存储（Redis）/ 接受重复

本次方案不为集群做预设计，单实例假设记入文档供未来追溯。

### 5.4 CSRF 与滥用面

端点不强制登录态意味着任何能访问 server 的请求都能产生日志记录。本节梳理实际威胁面与对策：

**威胁 1：XSS / 跨站脚本利用浏览器发请求**
- SameSite=Lax cookie 已存在但本端点不依赖鉴权，不构成此层防御
- **靠 server 全局 CORS 挡浏览器侧攻击**：允许 origin 集合在中间件层统一管理，本端点不重复实现 origin 检查

**威胁 2：脚本主动灌包**（curl / postman / 自写 client）
- Origin 可被伪造，CORS 挡不住非浏览器客户端
- 实际伤害：server stdout 多出垃圾日志，单批上限（100 条 / 1MB）约束单次量级
- **真正可见的负面影响不是磁盘爆满，而是垃圾日志把有用诊断日志在 rotation 滚走前挤掉**——磁盘容量被 docker log rotation 兜住，但有用日志会被噪声淹没/排出窗口
- 兜底机制：`deploy/compose.yaml` 配置 docker `json-file` driver，`max-size: 10m × max-file: 10`，单 container 约 100MB 滚动容量
- **应用层不防御**（不做 rate limit）——本次目标是稳定产品；真发生滥用 → 运维层封禁源 IP / 临时下线端点 / 调大 rotation 容量

**威胁 3：恶意账号灌包**（已登录用户滥用）
- 与威胁 2 同质——能登录的用户在 user 模式下，能脚本的用户在 anon 模式下，攻击成本几乎一样
- 处置同上：账号封禁 / 运维层兜底

总结：**不做 CSRF token，不做 rate limit**。本次目标是稳定产品（用排障日志），安全防护后续视实际情况再加。

---

## 六、过渡与回滚

### 6.1 过渡策略

- UI 端**直接切**到 HTTP 通道，不双写
- UI 是 PWA / Capacitor 内嵌 webview，发版时同步更新，无"老 UI 仍在野"场景
- Plugin 不动，维持 bot WS 通道

### 6.2 回滚安全网

- **仅 RTC signaling WS 上的 UI log 接收分支**保留 4 周作为死代码——这期间如果 HTTP 方案出严重问题，可以紧急回滚 UI 改动
- ⚠️ **不波及 plugin 的 bot WS log 通道**：plugin → server 的 `type: 'log'` 在 bot WS 上仍然是生产路径，4 周后清理 UI 分支时务必只删 signaling WS 那一处，不要误删 bot WS 的同名分支
- 4 周观察期无问题后，下一个稳定版本删除 server 端的 RTC signaling WS UI log 分支

### 6.3 文档同步

- 本文档与 [remote-log-channel.md](./remote-log-channel.md) 互为补充：后者描述总览（plugin 走 WS / UI 走 HTTP），UI 部分指向本文档
- [communication-model.md](../architecture/communication-model.md) §2.1 标注 UI 诊断日志已迁至独立 HTTP 通道（不再复用 RTC signaling WS）

---

## 七、安全与隐私

- **不强制登录态**：端点接受 anon 上报；身份用于打印标注（`[user:xxx]` / `[anon]`），不用于鉴权
- **Origin 校验由全局 CORS 提供**：本端点不重复实现 origin 检查，沿用 server 中间件统一配置
- **不传输内容/凭据**：log text 只承载连接元数据、状态机事件、错误码等诊断信息；调用方负责确保不写入 token、cookie、消息正文等敏感数据
- **不持久化**：server 端只打印到 stdout（依赖现有日志基础设施），不存盘、不入库
- **不解析内容**：server 端 text 字段透传，不做模式匹配 / 解析
- **不做 rate limit**：本次目标是稳定产品，安全防护后续视实际情况再加；滥用兜底由 docker log rotation + 运维层处置承担（详见 §5.4 威胁分析）

---

## 八、测试要求

### 8.1 单元测试

UI 端：

- 触发条件（100 条 / 5 秒）
- 顺序发送约束（in-flight 时新 batch 排队）
- 重试退避（各响应码分流、退避序列、上限终止）
- ring buffer 溢出（超容丢最旧）
- `ui.start` 首条 log 字段完整性
- 跨登录态发送行为不变（登录、登出动作不触发任何 flush / 状态切换）

Server 端：

- 单调 seq 接受 / 拒绝
- TTL 清理周期
- schema 校验各分支（uiId 非法 / seq 非法 / logs 非法 → 400）
- 身份标注（有 session → user / 无 session → anon）
- 单请求上限校验（超限 → 413）
- 与 plugin WS log 通道的输出格式区分

### 8.2 集成测试

- Server 重启场景下的重复量验证（应 ≤ 1 batch）
- 弱网注入丢包 / 延迟下的重试行为
- 跨 login/logout 的 uiId / seq 连续性

### 8.3 E2E

- 涉及 UI 主流程的话补 Playwright 用例（可在 server stdout 中 grep 关键事件验证）

---

## 九、不在本次范围

- Plugin → Server log 通道（继续走 bot WS）
- 服务端 metrics（命中率、payload 分布等）
- 服务端 rate limit
- 多 server 实例集群下的共享去重
- 日志持久化 / 聚合 / 检索
- CSRF token / 应用层身份认证（端点不鉴权，origin 校验沿用全局 CORS）
- 滥用监测与自动封禁（依赖运维层兜底）

---

## 十、附录：决策摘要

| # | 决策 | 选择 | 主要理由 |
|---|------|------|---------|
| 1 | 协议形态 | HTTP POST 短连接 + 批量 | RTC signaling WS 弱网频繁重建 → 关键窗口日志丢；HTTP 短连接每次按需建立 |
| 2 | 端点路径 | `/api/v1/log/ui` | 留 `/api/v1/log/plugin` 给未来扩展 |
| 3 | HTTP 方法 | POST only，其他方法 405 | 减小攻击面（GET/PUT/DELETE 等无效方法直接拒绝）；浏览器侧跨站防御由全局 CORS 提供 |
| 4 | 登录态门控 | **不限制**——anon 也能上报，cookie 仅用于身份标注 | 登录前事件是排障关键证据；门控对脚本攻击者门槛接近 0，无实质防御价值；UI 状态机大幅简化 |
| 5 | uiId | 冷启动分配 21 字符 nanoid | 全球唯一，跨用户不撞；跨登录态保持以便排障追溯 |
| 6 | seq 生命周期 | 属于 UI 实例（uiId），跨 login/logout 不重置 | 简化客户端状态机；同 uiId 下身份切换不影响去重 |
| 7 | 协议字段拆分 | body 显式 `{ uiId, seq, logs }` 三字段 | 避免组合 ID 与 server 内部 lastSeq 概念不对应 |
| 8 | 打印短标识 | uiId 尾部 8 字符 | 比 GitHub commit prefix 还宽，grep 友好 |
| 9 | 身份段渲染 | 有 session → `[user:<userId>]`；无 session → `[anon]` | 同 uiId 下 user / anon 切换揭示登录态变化时刻 |
| 10 | 字段命名风格 | 默认全称，仅 `tz` / `net` / `lang` / `ua` 等业界惯例缩写保留 | 与 plugin `coclaw.env` 风格一致 |
| 11 | Debounce | 100 条 / 5 秒 | 业界主流量级；UI 日志量不大；后台切换/进程被杀不做特殊处理，前台恢复后顺序续传 |
| 12 | 顺序发送 | 同时 1 batch in-flight | 单调 seq 去重的前提；把 server 重启重复量压到 ≤1 |
| 13 | 去重方式 | 单调 seq | 状态量小、实现简单、配合顺序发送精确度高 |
| 14 | Server map 默认值 | uiId 不存在时 lastSeq 视为 0 | 新实例首批 seq=1 自然接受，无特殊分支 |
| 15 | Schema 校验 | 进入去重/打印前必校验，违反 400 不更新 map | 防 UI bug / 恶意客户端污染 map |
| 16 | 单请求上限 | 100 条 / 1MB | 与客户端 debounce 阈值对齐；不存在 final flush 大 batch 场景 |
| 17 | 重试上限 | 数组驱动：10 次重试 + 30s cap（无墙钟闸） | 后台冻结/恢复语义友好；总时长由数组+cap 推出 |
| 18 | 重试队列容量 | 10 batch | 超容丢最旧 |
| 19 | Server 重启重复 | 接受少量重复 | 业界通行；batch 打印短前缀让重复可识别 |
| 20 | Logout 处理 | **不做特殊处理**；正常 debounce / 顺序发送继续 | 接受 logout 瞬间 ring 里"用户期"日志被标 anon 的轻微归属漂移 |
| 21 | Origin 校验 | 沿用 server 全局 CORS，端点不重复实现 | 全局 CORS 已含 coclaw.net 系 + `capacitor://localhost` 等合法来源；新来源走 `ALLOWED_ORIGINS` 环境变量扩展 |
| 22 | 限流 / CSRF token | 不做 | 本次目标稳定产品；安全防护后续视情况再加 |
| 23 | 过渡 | 直接切，不双写 | UI 同步发版，无野生老 UI |
| 24 | 回滚安全网 | RTC signaling WS 上的 UI log 分支保留 4 周死代码（不波及 plugin bot WS） | 紧急回退用 |

---

## 十一、实施回顾

设计阶段拆分的跨模块前提与待补项，全部已交付：

### UI 端（commit `e3ad675`）

- [x] **构建时 UI 版本号注入** `__APP_VERSION__`
- [x] **引入 `nanoid` 依赖**
- [x] **`ui.start` 字段采集**（touch / theme / cores / mem / tz / lang / net / ua，取不到的整字段省略）
- [x] **冷启动即开始发送**：不 watch authStore，不挂任何 login/logout flush hook
- [x] **建议 remote-log 初始化早于 auth 初始化**：`ui/src/main.js` 把 `useRemoteLog()` 放在 `createApp()` / pinia / auth 之前

### Server 端（commit `683ba36`）

- [x] 新 HTTP 端点 `POST /api/v1/log/ui`：POST only / schema 校验 / 单调 seq 去重 / 5min 周期清理 1h 过期条目
- [x] 身份标注：有 session → `[user:<userId>]`；无 session → `[anon]`
- [x] 打印格式：沿用 `fmtRemoteLogTs`，新增 `[batch=<uiId 尾部 8>:<seq>]` 短标识
- [x] **沿用全局 CORS**，端点不实现 origin 校验

### 测试

- [x] UI 端单测（vitest + jsdom）：触发条件、顺序发送、重试退避、ring/pending 溢出、`ui.start` 字段完整、跨登录态发送不变
- [x] Server 端单测（node:test）：单调去重、TTL 清理、身份标注、schema 校验各分支、405/413/400 各错误响应、与 plugin WS log 输出格式区分
- [x] 集成验证（commit `0315ac8`）：`server/scripts/verify-log-ui-integration.mjs` 覆盖 §5.1 / §3.3 / §3.4；`ui/e2e/remote-log-cross-auth.e2e.spec.js` 覆盖 §3.1 / §3.6 / §5.2

### 文档

- [x] 更新 [communication-model.md](../architecture/communication-model.md) §2.1（迁移完成态）
- [x] 更新 [remote-log-channel.md](./remote-log-channel.md) UI 部分（协议 / 去重 / 顺序 / 登录态对照）并指向本文档
- [x] 本文档状态从"待实施"切到"已实施"
