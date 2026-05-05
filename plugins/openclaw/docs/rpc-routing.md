# RPC 路由层（rpc-routing/）方案

> 给未来 agent 看：bridge 内部维护两份"短期路由表"——一份按 runId 找发起方 DC，一份按 reqId 找发起方 DC。
> 第一份（`RunEventRoutes`）已经抽成独立 class 落地；第二份（`RpcResRoutes`）方案敲定但**暂缓实施**，等需要的时候再开。
> 本文是一份"两件相似事的合并方案"，不到行号级——后续真要做时基于本方案再细化。

## 状态速览

| 路由表 | 抽离状态 | 落地时间 / 暂缓原因 |
|---|---|---|
| `RunEventRoutes`（runId → connId） | ✅ 已抽成独立 class，bridge 已接线 | 2026-04 落地，运行中 |
| `RpcResRoutes`（reqId → connId） | ⏸ 方案确认，暂未实施 | 纯整洁度收益、零功能收益；暂时优先级不够 |

---

## 为什么要有"路由表"

bridge 同时面对**多条**rpc DataChannel（多 PC，每个 PC 一条 rpc DC）。当 OpenClaw gateway 推上来一条消息时，bridge 要决定"这条到底回给哪一条 DC"。两类消息走两套路由：

1. **gateway 推回的 res 帧** —— 是某条 DC 之前发起的 rpc 请求的回包。按 reqId 单播给原发起方。
2. **gateway 主动 emit 的 `event:agent` 帧** —— 是某次 agent run 的事件流。按 runId 单播给真正发起这个 run 的 DC，而不是广播给所有 PC（避免死 PC、attach 旁观者也收到）。

两套路由都是**短期内存表**：
- key 短时间内有效，TTL 兜底防泄漏（默认 24h，1h 周期 scan）。
- bridge 的 ws 重连 / stop 时整表清空，连接断了路由也作废。
- 表条目数量很小（最多几十到几百），KV 用普通 Map 即可，不需要持久化。

## 共性设计哲学（两个 class 共用）

抽 class 的初衷是：**bridge 大文件里"操作 Map / Timer / TTL 的实现细节"和"bridge 业务逻辑"耦合在一起，读起来累**。抽离后 class 只管"路由表本身的纯粹行为"，bridge 端调用面是清晰的方法名。

### 接口骨架（两个 class 共有）

```
constructor({ logger, ttlMs, scanMs })   // 纯组装，无副作用
init()                                    // 起周期 scan timer，重入安全
add(key, ...payload)                      // 写路由
remove(key, ...)                          // 删路由
lookup(key) → connId | undefined          // 查路由
clear()                                   // 整表清空（不动 timer）
destroy()                                 // 停 timer + clear + 标 destroyed，幂等
```

### 共享设计要点

- **构造期不起 timer**：方便单测构造时不污染 global timer；timer 走 `init()` 显式起。
- **timer 必须 `unref()`**：否则会 hold 住 Node 进程退不出。
- **`destroy()` 后所有方法 no-op**：让 bridge 端 `?.method()` 调用模式安全；也避免 stop 后异步回调误触。
- **`__scanExpired` 整段 try/catch**：定期 scan 是 timer 回调，自身抛错（含 logger.warn 抛错）会击穿 gateway 进程。语义上 `expireAt <= now` 算过期。
- **`clear()` 不动 timer**：语义是"网关 ws 断开 → 表内条目作废，但实例还活着"，timer 留给后续 ws 重连后继续用。
- **`lookup()` 不顺手清过期**：hot path 保持简单，TTL 全权交给 scan timer。
- **logger 容错**：用 `logger.method?.(...)` 可选链；class 自己的 logger 副作用（如 scan warn / 跳过覆盖时的 debug）外层都包 try/catch。
- **薄封装**：class 是"路由表"，不掺业务决策；业务判断（要不要广播兜底、要不要打 warn）由调用方 bridge 决定（Q1 的特例见下文 RpcResRoutes 段）。

### 共享生命周期（在 bridge 内的位置）

| 时机 | 路由表动作 |
|---|---|
| 实例化（bridge 构造期） | 字段置 `null`（**延迟到 start 才 new**——确保拿到真 logger） |
| `start()` | `new RpcXxxRoutes({...})` + `init()` |
| `stop()` | `destroy()` + 字段置 `null` |
| 网关 ws close（含手动调 `__closeGatewayWs` / ws 自己 close handler） | `clear()`，timer 留着 |
| res 帧到达（终态）/ req 帧 SEND_FAILED | `remove(key, ...)` |
| res 帧到达（accepted）/ req 帧入队 | `add(key, ...)` |

`stop()` 内的清理顺序约定：先 `destroy()` 路由表实例 → 再 `__closeGatewayWs()`，避免反过来时 ws close handler 调到已 destroy 的实例（虽然 destroy 后 method 都是 no-op，顺序仍以"先把实例下线"为简洁）。

---

## 两个路由表的差异

| 维度 | `RunEventRoutes`（已落地） | `RpcResRoutes`（待实施） |
|---|---|---|
| key 语义 | runId（一次 run 的 ID） | reqId（每次 rpc 请求的 UUID） |
| key 撞号语义 | **业务可能发生**：同一 runId 被多次 RPC 共享（如 `agent.wait` attach 已有 run） | **违反前提的异常**：UUID 撞号几乎不可能 |
| 写入策略 | first-writer-wins：不同 reqId 跳过覆盖（首发优先），同 reqId 仅刷新 expireAt（debug 日志） | 直接覆盖；同 reqId 撞号 class 内 warn |
| 删除策略 | 要求 `entry.reqId === 入参 reqId`（防跨 RPC 撞号 runId 误删） | 直接 delete（reqId 是 key 本身） |
| value 内容 | `{ connId, reqId, expireAt }` | `{ connId, expireAt }` |
| 接口形参 | `add(runId, connId, reqId)` / `remove(runId, reqId)` | `add(reqId, connId)` / `remove(reqId)` |
| TTL / scan 默认值 | 24h / 1h | 24h / 1h |
| 触发的下游动作 | 命中 → `event:agent` 帧 unicast；未命中 → 广播兜底 | 命中 → res 帧 unicast；未命中 → 丢弃（无兜底——req 来源已经断） |

---

## RunEventRoutes（已落地）

### 用途与位置

把 OpenClaw gateway 推上来的 `event:agent` 事件流按 runId 单播给真正发起这个 run 的那条 DC。多 PC 场景下避免广播给所有连过来的 rpc DC（包括死 PC 和 attach 旁观者）。

源码：`src/rpc-routing/run-event-routes.js` + 同目录单测。已被 `realtime-bridge.js` 接线。

### 写入策略：first-writer-wins

同一 runId 可能被多次 RPC 引用（典型场景：`agent.wait` attach 同一 run），但事件应该只送给**真正发起这次 run 的 DC**。所以：

- 不同 reqId 命中已存在条目 → 跳过覆盖，记一行 debug。**首发优先**。
- 同 reqId 重发 → 仅刷新 expireAt，connId 锁死首发值（哪怕传入不同 connId 也不变——异常情况兜底）。
- 删除时必须验 `entry.reqId === 入参 reqId`，防止 attach 方完成后误删首发的路由。

### bridge 集成位置（类别）

| 调用 | bridge 内的位置类别 |
|---|---|
| `add(runId, connId, reqId)` | gateway 推上来 `res` 帧、状态为 accepted 且带 runId 时 |
| `remove(runId, reqId)` | gateway 推上来 `res` 帧、非 accepted 状态（终态/异常）时 |
| `lookup(runId)` | gateway 推上来 `event:agent` 帧时，确定 unicast 目标；miss 走广播兜底 |
| `clear()` | 网关 ws close（两个清理入口都要） |
| `init()` / `destroy()` | bridge `start()` / `stop()` |

---

## RpcResRoutes（待实施）

### 用途

把 OpenClaw gateway 推上来的 res 帧按 reqId 单播给原发起方 DC。比 RunEventRoutes 简单：reqId 是 UUID，撞号是异常，不需要 first-writer-wins，删除也不需要二次校验。

### 现状（暂缓的对象）

**reqId 路由表当前以 `Map` + 散布的 18 处代码内联在 `realtime-bridge.js` 中**。具体类别：

- 字段：路由表 Map + scan timer 句柄
- 常量：reqId 表的 TTL / scan 间隔（bridge 私名前缀）
- 注入口：deps 注入的可覆盖 ttlMs / scanMs（给单测用）
- 生命周期：`start()` 内手写 `setInterval` + `unref()`；`stop()` 内 `clearInterval`
- 清表入口：网关 ws close 两处
- res 路径：lookup + 终态 delete
- req 路径：撞号检测（has + warn + delete）+ 写入；SEND_FAILED 撤回

### 抽离方案

新增 `src/rpc-routing/rpc-res-routes.js`，与 `run-event-routes.js` 结构同款（共享设计哲学段那套骨架），接口形参按上表"差异"段。

**接口形参**：

```
add(reqId, connId)         // 直接 set；如已存在，class 内部 warn + 覆盖
remove(reqId)              // 直接 delete；不在表静默 no-op
lookup(reqId) → connId | undefined
```

**导出常量**：`DEFAULT_TTL_MS` / `DEFAULT_SCAN_MS`（与 `RunEventRoutes` 同名，bridge 端 import 时按需 alias，避免命名空间冲突）。

### 三个决策点（已敲定）

**Q1：撞号 warn 放哪？→ class 内部。**

- reqId 是 UUID，撞号本质是"违反全局唯一前提"的异常情况，与 `RunEventRoutes` 那边"attach 同一 runId"是业务正常情况完全不同语义。
- 撞号警告是**完整性兜底**，不是业务决策。class 自己吼一嗓子最合适——bridge 调用就一行 `add()`，不必每次自己 lookup + warn。
- warn 内容只用到 reqId 本身，class 内能完整组装，没有"必须由 bridge 拼上下文"的需要。
- 这是与 `RunEventRoutes` 设计的**故意分叉**——薄封装哲学的边界由 key 撞号语义决定。

**Q2：`add()` 是否返回 boolean 表示"覆盖了旧值"？→ 不返回。**

Q1 选了"class 自己 warn"后，bridge 不再关心是否覆盖；返回值无人使用。接口面与 `RunEventRoutes`（也无返回）保持对称。

**Q3：常量名？→ `DEFAULT_TTL_MS` / `DEFAULT_SCAN_MS`。**

class 是通用基础设施，命名应中性；带"DC_REQ_*"前缀是 bridge 视角的私名，放进 class 模块反而把 class 和"reqId 路由这件具体事"绑死。bridge 端按需 alias 即可。

### 实施流程（两阶段，参考 RunEventRoutes）

**阶段 1：基础设施落地（class + 单测，不接线）**

1. 新建 `src/rpc-routing/rpc-res-routes.js`，结构参照 `run-event-routes.js`：构造 / init / destroy / add / remove / lookup / clear / __scanExpired。
2. 新建同目录 `.test.js`，用 `node:test` 风格。覆盖：构造与生命周期、写入（含撞号 warn + 覆盖）、删除（在表/不在表/缺参）、查询（命中/miss/缺参/不顺手清过期）、周期 scan（删过期 + warn / 边界 expireAt === now / logger.warn 抛错被吞 / logger.warn 缺失）、整表 clear（不停 timer）、destroy 后所有方法 no-op、真实场景补充（truthy 字符串 key、循环 add/remove 后无残留、logger=null fallback console）。覆盖率 100/100/100/100。
3. changeset：patch 级，描述"introduce class as standalone infrastructure, behavior unchanged, not yet referenced"。
4. commit："feat(plugin): introduce RpcResRoutes as standalone infrastructure"。

**阶段 2：bridge 接线 + 集成测试 + 三轮 deep-review**

把 bridge 内的 18 处内联代码全部替换为 class 调用：

- 删除常量定义、Map 字段、scan timer 字段
- 构造函数 deps jsdoc / 字段保留可注入 ttlMs / scanMs（用于单测短值），新增 `__rpcResRoutes = null` 字段
- res 路径：`__dcPendingRequests.get(id)` → `__rpcResRoutes?.lookup(id)`（注意返 connId 而非 entry 对象，所有 `info.connId` 改直接用 `info`）；终态删除调 `remove`
- req 路径：撞号检测 `has() + warn + delete + set` → `add()`（warn 内化进 class 后 bridge 一行）；SEND_FAILED 撤回调 `remove`
- close 两处：`Map.clear()` → `__rpcResRoutes?.clear()`
- start：删除手写 setInterval 块，改为 `new RpcResRoutes({ logger, ttlMs, scanMs })` + `init()`
- stop：删除 `clearInterval` 块，改为 `destroy()` + 字段置 `null`

bridge 集成测试：参考 `run-event-routes` 第二阶段补的 12 条端到端 case 模式（lookup hit/miss、stop+start refresh、close 直调清表、destroy 后字段 null + in-flight res 安全），但既有 `dc unicast:` 段已有 ~13 条 case 覆盖大部分路径，新增 case 主要补 lifecycle 和"撞号 warn 路径端到端"。

**deep-review 重点**：
- changeset 描述要随阶段 2 集成更新（不能停在阶段 1 的"behavior unchanged"）
- class 顶部注释要随集成更新（删掉"未集成"措辞）
- 测试 section 注释一律中文
- 场景覆盖必须过"生产可达 + 失败后果明显 + 性价比合理"三项过滤，宁缺毋滥

### 实施风险

- **行为不变**是硬约束：抽离后任何行为差异都是 bug。撞号 warn 文案变化、debug 日志位置变化属于可接受的"措辞差异"，但语义必须等价。
- bridge 是 1600+ 行核心模块，改动 8 处接线点要全部对齐生命周期和守卫；deep-review 必走。
- 不要顺手扩大变更面（比如想着"既然在改路由表了顺手把 logger 调用规范化一下"——拒绝）。

---

## 决策记录：为什么暂缓 RpcResRoutes

`RpcResRoutes` 抽离是**纯整洁度收益、零功能收益**：

**收益**：
- bridge 文件少 ~30 行，"reqId 路由表"作为概念在一个 class 里集中
- 路由表的 TTL/边界 case 有专属单测，比塞集成测试精炼
- 配齐 rpc-routing/ 目录的"路由层"抽象，与 `RunEventRoutes` 形成姊妹模块

**代价**：
- 新增 ~600 行（class + 单测），bridge 改 8 处接线点
- 三轮 deep-review，行为不变意味着风险全在"改坏既有逻辑"

**决定（2026-05-04）**：方案敲定，但**暂缓实施**。bridge 内 reqId 表当前是"散落 18 处但每处都很短"的形态，维护成本可接受；优先级让位给真正修 bug / 加功能的工作。后续真要做时直接基于本方案展开。
