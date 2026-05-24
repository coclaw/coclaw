# UI TODO

非阻塞改进点登记。每条记录"问题 / 修复方向 / 关联 commit"。

## sessions.list dedup deep-review 发现的预存问题

**发现日期**：2026-05-11
**关联 commit**：refactor(ui): share sessions raw via sessions.store between dashboard and MainList

来源：dashboard / sessions.store 合流改造的深度 review，4 个 codex-rescue 实例核实出的与本次改动无直接因果的预存问题。

1. **同 id 重绑场景下旧 fetch 写入身份不验证**
   - 现状：`__doLoadForClaw` 只检查 `clawsStore.byId[id]` 是否存在，不验证是不是同一个 claw 实例。极端时序：claw A 被解绑、同 id 立刻重绑成 claw B，期间 A 的旧 fetch 跑完后会看到 `byId[id]` 存在（指向 B）就把 A 的 raw（以及 SessionItem）写给 B。日常使用几乎不可能触发，但属于已知风险。
   - 修复方向：fetch 启动时记录一个 fingerprint（比如 conn 引用或 claw 的随机 id），写入前与当前 fingerprint 比对；不一致则丢弃。需要先核实业务上有没有可用的 fingerprint。
   - 同源副本（一并修）：**2026-05-24 复核发现** `topics.store.__doLoadForClaw`（topics.store.js:114-130）同样只判 `clawsStore.byId[id]` 不验 conn 身份；与 sessions.store 同套修法（snapshot `useClawConnections().get(id)`，await 后双重比对），不要遗漏。
   - 另两个同源点（**2026-05-24 deep-review 第二轮新增**）：
     - `topics.store.createTopic`（topics.store.js:157-178）—— `useClawConnections().get(id)` 拿的 conn 实例 await 后未做身份重核；同 id 重绑窗口可能把旧 plugin 那边创建出来的 topicId 写到新 claw 名下，造成"幽灵话题"（新 claw 刷新 topics 列表时不含这条）
     - `topics.store.generateTitle`（topics.store.js:225-244）—— 同样 conn 实例无身份重核；窄窗内回包到达时换主，title 应到"幽灵话题"对象上（实际副作用极小，UUID 撞 id 概率几乎为零；登记跟踪以保一致）
     - 与 `__doLoadForClaw` 共用同套修法（snapshot conn → await 后 `useClawConnections().get(id) === conn` 比对，否则抛 CLAW_DISCONNECTED）；ChatPage 上层已有现成的 CLAW_DISCONNECTED 处理（清 draft + notify + 跳走），无需改调用方
     - 触发窗口极窄（请求中段同 id 解绑+重绑同时发生），非阻塞

## chat.store loadMessages 周边的预存问题

**发现日期**：2026-05-06
**关联 commit**：fix(ui): decouple dropRun from auxiliary chat.history (双气泡 bug fix)

来源：双气泡 bug 修复时的 deep-review。两条与本次修复主题相关但**修复前后行为一致**的预存问题，单独追踪。

1. **`/new` / `/reset` 后 `chat.history` 失败导致 historySegments 归档丢失**
   - 现状：`chat.store.js:1133-1149` 在斜杠命令 final 分支拍照 `prevSessionId` 然后 silent reload，归档判定靠 `this.currentSessionId !== prevSessionId`。如果 `chat.history` 在 reload 中失败，`currentSessionId` 保留旧值，条件 false negative，旧消息**不进归档**——而 `sessions.get` 已经把消息从 `this.messages` 换成新 session，旧消息相当于丢失（用户切回历史看不到）。修复前后行为一致（旧代码 `chat.history` reject 时 `currentSessionId` 也保留旧值）。
   - 修复方向：归档判定改用 `prevMessages.length > 0 && (this.currentSessionId !== prevSessionId || chat.history 失败)` 兜底；或者 final 分支调 `loadMessages({ silent: true })` 之后**强制刷一次** `chat.history`（不依赖外层 reload）。

2. **`sessions.get` 自身失败时 `dropRun` 跳过，"思考中"单气泡永久 orphan**
   - 现状：`chat.store.js` `__awaitPersistAndDrop` 内 `loadMessages` 失败（含 `sessions.get` reject）保留旧策略不 `dropRun`——避免清掉 `streamingMsgs` 又拉不到终态消息。
   - **关键事实（第三轮 review 核实）**：`__endRun`（`agent-runs.store.js:441-444`）已经清掉了 `run.__timer`（`POST_ACCEPT_TIMEOUT_MS=24h` 兜底）。之后任何 silent reload 触发 `__reconcileRunAfterLoad → stripLocalUserMsgs` 时又因 `run.ended=true` 早返回（`agent-runs.store.js:547`），不动 `streamingMsgs`。结论：**`sessions.get` 失败时 streamingMsgs 永久 orphan，直到 chat 销毁/重建**，不是"24h 后自愈"。
   - 修复方向：增加一个更短的 fallback timer（比如 5 分钟）：`loadMessages` 失败后挂一个 retry timer，若仍失败再 `dropRun`。或借 `agent.run.end reason=failed` 信号源直接 `dropRun`（与 `endReason='rpc'/'wait'` 区别处理）。
   - 注：与本次双气泡 bug 是相邻问题（ghost 渲染另一个变体），但修复策略不同。

3. **多个 `loadMessages` 并发写 `this.messages` 时的乱序覆盖（force 路径残留）**
   - 现状：第三轮加的 `force: true` 让 `__awaitPersistAndDrop` 绕过飞行守卫起独立 `doLoad`。两个 force load（fast-follow 双 run 终态）或一个 force load + 一个非 force silent reload 同时在飞时，sessions.get 返回顺序乱序的话，靠后的 `this.messages = ...` 写动作会覆盖更新的快照，短暂复现 stale-A vanish。
   - 触发条件：要求两个 sessions.get 阶段的 RPC 乱序到秒级以上（同条信令通道、同时段、回程顺序倒置）——实际几乎不可能。最坏后果是临时 vanish，下次任意 `loadMessages` 自愈。
   - 修复方向：给 force load 加 `__forceSeq` 序号，写 `this.messages` 前检查"自己是不是最新"——被 superseded 的不写 messages 但仍 fire 自身 hook（保 dropRun 不漏）。第三轮没加是因为权衡后认为"加了引入的状态机比解决的问题更复杂"。如果未来线上观察到该症状再加。
   - **第五轮 review 补**：`loadOlderMessages`（向上翻历史）也是同类竞争者，写 `this.messages = [...wrapped, ...localMsgs]` 与 force 路径写不互斥。触发条件比 #3 主项还窄（用户必须正在翻历史 + run 终态恰好同时落地），且实际后果比 stale-A vanish 更轻（`loadOlderMessages` 拉的是更长的最新 N 条，本来就含本 run 终态消息）。如果未来 #3 主项实施 `__forceSeq` 防覆盖，应把 `loadOlderMessages` 写 `this.messages` 也纳入同套保护。

## ProgressRing 后续优化

**发现日期**：2026-04-14
**关联 commit**：refactor(ui): unify progress indication with circular ProgressRing

来源:深度 review 4 个 subagent 报告(opus)+ 最终 review。所有问题非阻塞,可在后续迭代中按优先级处理。

### 体验 / 可访问性

1. **进度环 aria-label i18n 化**
   - 现状:`ProgressRing.vue:81` 默认 `'Progress'` 英文硬编码,三处使用点(`ChatInput`/`FileUploadItem`/`FileListItem`)均未传 `aria-label`。中文读屏用户会听到 "Progress 50 percent" 混读
   - 修复:调用方传入 `:aria-label="$t('files.uploading')"` 等场景化文案;同步新增 `files.uploading` / `files.downloading` / `chat.attachmentUploading` 等 i18n key 到所有语言

### 实现优化

11. **`indeterminate` 用 `Number.isFinite`**
    - 现状:`return this.value == null || Number.isNaN(this.value)`
    - 修复:`return !Number.isFinite(this.value)` 一并覆盖 ±Infinity / 字符串 / 非 number 等异常输入

12. **不定态加"呼吸"动画**
    - 现状:固定 25% 弧 + `animate-spin` 匀速旋转,比 Quasar `q-spinner-oval` 单调
    - 修复:可选地添加 `stroke-dashoffset` 关键帧,让弧长在 25%~75% 之间脉动

13. **`radius` 提为模块常量**
    - 现状:`computed.radius() { return 50; }` 一个 computed 返回常量
    - 修复:`const RADIUS = 50;` 模块级常量,`circumference()` 直接引用

14. **下载/AI 推理场景接入 ProgressRing**
    - 现状:`ChatFile.vue:22-24` / `ChatImg.vue:22-25` 用 boolean `:loading`,无字节级下载进度;`ChatMsgItem.vue:8` 发送中用 `i-lucide-loader-2 animate-spin`
    - 修复:将来需要细粒度进度时,用 `<ProgressRing :value="..." />`(确定态)或 `<ProgressRing />`(不定态)替换

## Bug 1 修复 review 后续（lifecycle 抢跑 → "任务未完成"）

**发现日期**：2026-04-26
**关联 commit**：
- `39051af` fix(ui): wait for transcript persistence before dropping streaming overlay
- `f91014c` docs(openclaw-research): document agent run persistence timing and signal guarantees

来源：codex-rescue + Claude 双线 review。本节列出 review 中浮出但本次不动的疑似 bug / 优化点。

### 疑似 bug

1. **streaming overlay 永久残留 bug（DC 失联场景）** — 详见 [`ui/docs/streaming-overlay-stuck-bug.md`](docs/streaming-overlay-stuck-bug.md)
    - 触发条件极窄（≥3 分钟持续网络故障 + ICE restart 预算耗尽），用户能通过发新消息自愈，**暂不修复**
    - 文档涵盖：完整链路、关键事实核实（assistant 增量流是 cumulative、microtask 原子窗口）、4 个修法方案及影响面、源码锚点速查
    - 原 #31（`run.ended` 与 streamingMsgs 合并语义错位）属同一 bug 不同侧面，已合并入文档

## ICE-restart 代次号（restartGen）协议（跨 UI + plugin）

**发现日期**：2026-04-26（本批未实施，登记到此）
**关联 commit**：`fa42501` 提的 backlog（`rtc:restart-rejected generation-id design`）
**第 9 轮已落 UI 侧 partial 闭合**：`bd394fc` 闭合"旧 restart 已 close 后状态离开 restarting"子窗口；本条覆盖剩余的"旧 restart 已 close 后又进入新 restart"子窗口

1. **`rtc:restart-rejected` 加 `restartGen`，UI 收时按代次号 drop 旧 reject**
    - 现状：UI 当前用 `webrtc-connection.js` 的 `__state === 'restarting'` 做粗粒度 stale guard。旧 restart 在飞 → pause/rebuild → 新 PC 进 restarting → 旧 reject 迟到时若新 PC 恰好也在 restarting 态，会被误杀（误触发 close + asFailed）
    - 修法：
        - plugin 三处发 `rtc:restart-rejected` 的位置在 reject payload 里加 `restartGen`（回带接收到的 ICE restart offer 携带的代次号）
        - UI 发 offer 时带 `restartGen: this.__restartEpoch`
        - UI 收 reject 时校验 `restartGen` 是否匹配当前 epoch；不匹配 → drop 旧 reject
        - **legacy plugin fallback**：reject payload 缺 `restartGen` 时回退到当前 state-only guard，保持兼容
    - 跨工作区，需双 changeset（UI + plugin），是本批唯一动 plugin 代码的任务
    - plugin 工作区独立验证：`cd plugins/openclaw && pnpm verify`
    - 设计文档放 `docs/designs/`，引用 `rtc:restart-rejected` 帧定义
    - 必须配套补 integration test：构造"旧 restart 在飞 → pause/rebuild → 新 PC 进 restarting → 旧 reject 迟到带旧 `restartGen`"，断言旧 reject 被 drop
    - **红线 6 风险点**：DC 延续场景（restart-paused 跨 ICE restart）必须保留 PC，不能误 close。改 reject 处理逻辑时要保证 stale reject 真被 drop，不让旧 reject 误触发 close + asFailed
    - 上手第一步（待开工时执行）：
        1. `git show fa42501` 看完整背景
        2. 跟用户对齐 plugin 发版 cadence + rollout 策略（旧 plugin + 新 UI 共存窗口可接受？）
        3. grep `__restartEpoch` / `restartGen` / 现有 ICE restart offer 出站结构
        4. plan 阶段写出方案 → 用户拍板 → 实施
        5. plugin commit + UI commit 各自独立（双 changeset）

## 发布前门禁 review 发现的非阻障项（2026-04-26）

来源：8 路并行 review（4 codex + 4 后台 claude -p）。仅登记值得追踪的疑似 bug 和 backlog 跟踪丢失项；G2/G3/G1 的 nit（vite 配置选择 / changeset 标签错位 / refinement chain 等）不登记。

1. **`topics.store.createTopic` 缺 post-await `byId` re-check（ghost-topic-on-removed-claw race）**
    - 来源：commit 9ab962d round 24 backlog
    - 现状：`createTopic` 在 await 期间 claw 被 removeClawById 时，return 后仍可能写入 ghost 条目。窄窗口
    - 修法：post-await 加 `byId` re-check，被 evict 即放弃

3. **`__ensureRtc` connected early-return 当 `rtc.state==='connected' && !rtc.isReady`**
    - 来源：commit 54b609d round 20 backlog
    - 现状：`__ensureRtc` early-return 看 state===connected，但 isReady=false 时 DC 实际不可用；窄窗口可能 short-circuit 错误判定
    - 评估（2026-05-24 复核）：`isReady` 来自 DC `__rpcChannel.readyState === 'open'`，`conn.rtc` 只在 DC `onopen` 里写入；`state==='connected' && !isReady` 在 `__ensureRtc` 调用点几乎不可观测。即便发生，DC 真死走 `dc.onclose → close({asFailed:true}) → __scheduleRetry` 路径自愈，10s 后正常重建
    - 修法（建议）：加一行 `remoteLog('rtc.ensureSkip-noDC ...')` 观察；生产频次=0 则关本条；>0 再考虑改 early-return 条件

5. **`isConnectingRtc` / `unreachableClaws` getter 语义在 sig offline + rtcPhase=building/recovering 期间不清晰**
    - 来源：commit 4ae005e round 19 backlog（"P2-5"）
    - 现状：sig offline 时 `rtcPhase` 可能仍是 building/recovering（pre-existing 残留），UI 看到的 isConnectingRtc / unreachableClaws 状态不直觉
    - 决策与 SignalingBanner UX 工作捆绑，等 UX 推进时一并处理

6. **`manualRetryUnreachable()` 不直接检查 `_sigOffline`（UX wart）**
    - 来源：commit 68d9f99 round 18 backlog
    - 现状：`manualRetryUnreachable` 是用户点"重试"按钮触发；sig 不通时仍会进入 retry 流程，看似无反应。UX 不友好
    - 修法：UX 层面在 sig offline 时 disable 按钮 + 提示文案；或 `manualRetryUnreachable` 入口加 sig gate + 反馈

## "刷新触发流式占位错位" fix 多维度 review 发现的预存问题（2026-04-30）

**关联 commit**：`807c300` fix(ui): advance streaming anchor on strip to keep refresh-during-run grouping correct

来源：第 1 + 第 2 轮 codex-rescue 多维度并行 review。这两条均**自 55212ea (2026-04-06) 引入 anchorMsgId 起就存在**，本次 fix 只解了"必现 refresh"主路径，未触及这两条；非阻塞登记。

1. **`!anchorId` 分支误 strip：当 server 返回历史 user 但当次 user 尚未持久化时，optimisticUser 被错误清掉**
    - 现状：`agent-runs.store.js` `stripLocalUserMsgs` 的 no-anchor 分支用 `serverMessages.some((m) => m.message?.role === 'user')` 判定 server 是否已持久化当次 user。但这条只检查"server 有任意 user 消息"，无法区分"老历史 user"和"当次 user"
    - 复现路径（窄但真实）：activate 失败 → `this.messages=[]` → 用户 send（anchor 计算为 null）→ 用户立刻刷新（赶在 OpenClaw 持久化 curr_user 前）→ server 仅返回 `[old_user, old_a]` → `some(user)` 命中 old_user → optimisticUser 被 strip → optimisticClaw 末尾追加，merge 进 old_a 的 botTask → **用户刚发的消息从 UI 消失，老对话戴上"思考中"**
    - 触发条件较窄：activate 必须先失败（少见），用户必须立即送消息且立即刷新（罕见）
    - 修复方向：
        - 方案 A：no-anchor 分支额外校验"server 那条 user 是否在锚点时间窗口之后"——但需要时间戳，且 anchor 是 id，不直接可比
        - 方案 B：在 `register` 时若 `anchorMsgId=null` 且 `optimisticUser.timestamp` 已知，记录一个 `runStartTs`；no-anchor strip 时只接受 `timestamp >= runStartTs` 的 server user
        - 方案 C：彻底改 anchor 语义为"时间戳锚点"而非"id 锚点"，规模较大
    - 必须配套补 chat.store + agent-runs.store 单元测试（"no-anchor + server 仅有历史 user 无 curr_user"场景）

## MainList agent 排序 deep-review 发现的预存问题（2026-05-01）

来源：MainList 排序 + 标签改造 deep-review。第 1 轮 codex-rescue 并发维度报告。该问题**自 sessions.store 引入 `_loadingPromise` / `_perClawLoading` 合流以来就存在**，本次重写（`chat.history` → `sessions.list`）只是沿用原合流模式，未触发但暴露出来。

1. **`_loadingPromise` 老 promise 的 stale finally 在 logout/同 id 重绑窗口可能误清替换 promise**
    - 现状：`sessions.store.js:121` 的 `_loadingPromise = null` 是**无条件清**，没有像 `_perClawLoading.set` 那样的"仅当 Map 当前条目仍是本 promise 时才清"identity guard
    - 时序：旧 `loadAllSessions()` 在飞 → logout 触发 `__resetSessionsInternals` 清内部状态 → 新 `loadAllSessions()` 写入新 promise → 旧 finally 跑到 `_loadingPromise = null` → 把替换 promise 也清了 → 下一次同时刻并发的 `loadAllSessions()` 不再合流，发起独立 RPC
    - 实际影响：极窄窗口 + 仅多发一次 RPC，无功能性故障
    - 修法：参照 `_perClawLoading.finally` 的 identity 比较模式：`if (_loadingPromise === p) _loadingPromise = null`
    - 非阻塞

## MainList 排序 deep-review 第 2 轮发现的预存问题（2026-05-01）

来源：commit f201b0a 上的第 2 轮 deep-review（5 路并行 codex-rescue + 1 opus 重派）。下列条目均与 f201b0a 改动无关，本次 review 中浮出。

1. **`agent-runs.store.runAgent` register 早于 chat 层 onAccepted → 极迟到 accepted 后产生 split-brain**
    - 来源：commit `44e3bf3` 引入 runAgent 抽象时即存在
    - 现状：`agent-runs.store.js:209-228` 内 onAccepted handler 先 `register(runId, ...)` + `__startWatcher`，再调 chat 层 onAccepted；chat 层 pre-accept 180s 超时（`chat.store.js:527`）已触发 → catch 已跑 → `preAcceptInvalidated=true` 短路 chat 层 onAccepted；但此时 agent-runs 已注册了真实 run，watcher 已起，`allMessages` getter 仍会把 streamingMsgs 合进 UI
    - 触发条件极窄：server 在 180s 后才 accept；通常 DC 早 reject 了
    - 实际影响：用户看到一条挂着的"流式消息"但 chat 层不知道存在；按 STOP 走 pre-accept 分支（设 `__pendingCancelIntent`），无 onAccepted 消费，UI 卡在 cancelling 状态直到自然终结或刷新
    - 修法方向：runAgent 的 onAccepted 在调外部 onAccepted 之前等其返回 sentinel，或外层加"chat 层已认定 pre-accept 失败 → 立刻 unregister run + abort RPC"通道
    - 配合 §"Bug 1 修复 review 后续" 的 #16 / #17 一并思考

2. **claw 解绑后短时同 id 重绑期间，旧 fetch 结果可污染新 claw**
    - 现状：`removeSessionsByClawId` 清 `_perClawLoading` 但不清全局 `_loadingPromise`；旧 `loadAllSessions` 飞行中 → claw 解绑后短时同 id 重绑 → `mergeFetchResults` 的 `clawsById[bid]` 校验通过（新 claw 在）→ 旧数据被写入新 claw 空间
    - 触发条件：极窄；需在飞行中 + 同 id 重绑 + clawsById 已有新 claw 实例
    - 修法方向：`__doLoadAll` 的 results 处理环节加 claw 实例 identity 比对（不仅看 byId 是否有 entry，也看是不是同一个 claw 对象）；或 removeSessionsByClawId 同步给一个 epoch，旧 fetch 结果按 epoch 丢弃

3. **slash 命令期间点 STOP 留下 `__pendingCancelIntent` 残留 → `isCancelling` getter 误亮**
    - 现状：sendSlashCommand 期间 `sending=true` → STOP 按钮可见可点；`cancelSend` 走 pre-accept 分支（chat.store.js:781-789）设 `__pendingCancelIntent=true` 后返回 null。slash 路径既无 onAccepted 来消费这条 intent，`__cleanupSlashCommand`（line 1080-1094）和 slash catch 块也都不清；intent 残留到下次 sendMessage / sendSlashCommand 入口的 `__clearCancelling('superseded')` 才清掉
    - 实际影响：用户感知"点了 STOP 没反应"，且 slash 自然结束后期间 `isCancelling` 仍为 true（依赖 `__pendingCancelIntent`，line 168-170），可能影响其它依赖 getter 的 UI 反馈
    - 修法方向：a) UI 在 slash 期间 disable STOP 按钮（chatStore.__slashCommandType 非空时）；或 b) `__cleanupSlashCommand` 同步清 `__pendingCancelIntent`（slash 不可被服务端取消，intent 没有意义）

4. **`getActivity` 在 MainList 排序中 O(A×S) 线性扫描**
    - 现状：`sessions.store.js:49-57` `getActivity` 对每个 (clawId, agentId) 全量遍历 items；MainList 的 `agentItems` computed（`MainList.vue:383, 400`）对每个 agent 调一次，最坏 O(A×S + A log A)
    - 实际影响：几十条 item 内可忽略；多 claw 多 session 长期使用后可能延迟 MainList 渲染
    - 触发阈值（2026-05-24 复核）：单 claw agent > 20 或多 claw 合计 > 50 时考虑动手
    - 修法方向：sessions.store 内维护 `Map<clawId:agentId, item>`，getActivity O(1) 命中。写入口实测 5 个（`setSessions` / `removeSessionsByClawId` / `bumpActivity` 内 2 处 / `loadAllSessions` 空 claws 早返回 / `__doLoadForClaw` 合并）；`bumpActivity` 内 `findIndex` 顺手一起 O(1) 化

## 输入区附件 per-chat/topic 隔离（方案 A''）deep-review 发现的非阻塞项（2026-05-03）

来源：4 路并行 codex-rescue review（3 路按维度切分 + 1 路综合）。本批主要 bug 已在同 commit 修复，下列为相关边角与预存问题。

1. **ImgViewDialog 直接复用 store 的 ObjectURL，store dispose 期间预览会裂图**
    - 现状：`ChatInput.vue:476-480` `previewImg(f)` 把 `f.url` 拷到 `previewImgSrc` 显示。若 LRU 淘汰 / 登出 / promote dispose 触发 `chat.store.dispose` revoke 该图片 url，dialog 仍持引用，浏览器看到 `blob:` 但实际无效，图裂
    - 触发：用户预览着图 + 同时触发 store dispose（10+ topics 时 LRU、登出、promote 流程）
    - 与本次方案的关系：附件归 store 管后，store dispose 路径增加，命中概率放大；但 dialog 与 store 解耦的修复是独立工作
    - 修法：dialog 打开时单独 `URL.createObjectURL(f.file)` 自建副本，关闭时自 revoke；外部 `f.url` 仅用于缩略图列表渲染
    - 设计 dump 已标注本项可同期顺手修，未在本次范围内

2. **`__handleNewTopicSend` 中 router.replace 失败时 oldStore 视图破图**
    - 现状：`ChatPage.vue:640-684` promote 之后 `newStore.inputFiles === oldStore.inputFiles`（同源数组）。若 `router.replace` 抛错（如 router guard 取消），catch 路径上 `targetStore` 已被赋值为 newStore，会调 `targetStore.clearInputFiles()`：循环 revoke 共享数组里所有图片 url 后再 `this.inputFiles = []`（重指向空数组）。但 oldStore.inputFiles 仍指向原数组（含已 revoke 的 url），ChatInput 看的是 oldStore，所有图片立即破图
    - 触发条件：仅 router.replace 抛错就足够（不需要 LRU 同时触发）。router guard 抛 false / next(false) / 守卫 throw 都算
    - 修法方向：catch 中检测 promote 已发生但 router.replace 失败 → 切断同源（先把 newStore.inputFiles 重指向独有空数组，再 dispose newStoreKey），然后在 oldStore 上做 clear+restoreFiles
    - 实际影响：本项目当前 router 配置下 replace 抛错的场景有限，但只要触发就视觉很差

## 输入区附件 per-chat/topic 隔离 deep-review 第 2 轮发现的非阻塞项（2026-05-03）

来源：第二轮 4 路并发 codex-rescue review。本批未发现真必修业务问题（仅 2 处文档/注释偏差当场修复）；下列为发现的边角与预存问题，登记备查。

1. **`chatStoreManager.dispose()` 部分失败时 instances/topicLru 残留**
    - 现状：`chat-store-manager.js:86-95` `store.dispose()` 或 `$dispose()` 抛异常时，下面的 `instances.delete()` + `topicLru.splice()` 都跑不到，受害者会留在两个索引里
    - 已有部分缓解：`__evictTopics`（chat-store-manager.js:140-151）外层有 try/catch + 兜底硬清，但仅覆盖 LRU 淘汰路径；其它调用方（`commit()` 内的 dispose、`disposeAll`）未兜底
    - 预存问题：本次修复未改 `dispose()` 函数体；该问题在 ba3bf63 之前就存在
    - 修法方向：把 `instances.delete()` + `topicLru.splice()` 放进 finally，分别对 `store.dispose()` / `$dispose()` 各包 try/catch

2. **`promoteToTopic` 内部抛错时新建的 newStore 泄漏**
    - 现状：`chat-store-manager.js:62-83` 中 `this.get(newStoreKey, opts)` 已 instances.set 新 store；若后续 `newStore.activate({skipLoad:true})` 或 `inputFiles` 赋值抛异常，promote 函数抛出后 ChatPage catch 里 `targetStore` 仍是 null，无法 dispose 这个泄漏的 newStore
    - 现实概率：极低——`activate({skipLoad:true})` 是同步且短路的，正常路径不抛
    - 实际影响：泄漏 1 个 topic store + 其 inputFiles 中的 ObjectURL，登出 disposeAll 兜底
    - 修法方向：promoteToTopic 内部 try/catch，失败时 dispose(newStoreKey) 后 rethrow

3. **`__handleNewTopicSend` 各 await 后未检查组件已卸载**
    - 现状：`ChatPage.vue:626-684` 用户在 createTopic / router.replace / sendMessage 任一 await 期间返回 /topics 列表，函数仍继续跑——createTopic resolve 后 promote + router.replace 会强行把用户从 /topics 拽回到 topic chat 页面
    - 现实概率：用户点发送后毫秒级返回（如手机 back swipe）才能触发
    - 这是 Vue Options API + async router 的通用模式问题，不仅限于本次修复，但本次新增 router.replace 让它更明显
    - 修法方向：beforeUnmount 设 `this.__unmounted = true`，每个 await 后早返回 + 已发起的 newStore 主动 dispose

4. **`saveBlobToFile` 异常路径未 revoke ObjectURL**
    - 现状：`src/utils/file-helper.js:156-169` Web 端创建 ObjectURL 后 a.click → removeChild → revoke 是直链；中间任一步抛异常会跳过 revokeObjectURL
    - 预存问题：本次修复未触及该函数
    - 修法：用 try/finally 包住 DOM 操作部分，确保 revokeObjectURL 一定跑

5. **`procRecordedVoice` 绕过 MAX_UPLOAD_SIZE 校验** — **已评估保持现状（2026-05-24 复核）**
    - 现状：`ChatInput.vue:449-460` 录音文件直接 `chatStore.addFiles([item])`，跳过 `addFiles` 入口的 MAX_UPLOAD_SIZE 检查
    - 实际影响：录音受 MAX_RECORD_DURATION + audioBitsPerSecond 双重限制，理论上限约 1.2MB，远低于 1GB 上限，不会触发
    - 评估结论：改走 `this.addFiles([file])` 会丢 `durationMs` 字段（录音侧专有标注，`this.addFiles` 入口签名不透传 extras）；继续保留当前实现
    - 备忘（若将来想统一）：在 `procRecordedVoice` 内部内联 `if (file.size > MAX_UPLOAD_SIZE) ...` 三行判断即可，不改 `this.addFiles` 入口

## toolCall 数据已留住，渲染 + 配对 + 增量结果待补（2026-05-03）

**背景**：本次只补齐了"数据层不阉割"——直播路径（`agent-stream.js`）和回放路径（`session-msg-group.js`）现在都把 `toolCallId` / `args`（`tool_use.input` 归一化）、toolResult 的 `toolCallId` / `isError` 透传到 step。但渲染层完全没动，下面三件事共用同一份"按 `toolCallId` 索引到原 toolCall step"的能力，登记后续一并设计落地。

1. **toolCall step 加可展开折叠区，展示 args + 完整 toolResult**
    - 现状：`ChatMsgItem.vue:130-134` 只画工具名 pill；toolResult 走另一条 step，受 `max-h-32` 限制
    - 修法：toolCall step 默认收起，点击展开看入参（pretty-printed JSON）+ 配对的 toolResult 完整内容；UX 设计时考虑 args 体积（长 bash 命令不刷屏）

2. **toolCall ↔ toolResult 按 `toolCallId` 显式配对**
    - 现状：`session-msg-group.js` 的 `processToolResult` 把 toolResult 直接 push 到 `currentTask.steps` 末尾，纯按 JSONL 出现顺序堆叠；`agent-stream.js` 直播路径同样按事件顺序排
    - 触发：现代模型并发发起多个 tool_use 块（同一 assistant message content 数组里有多个 tool_use），结果按各自跑完速度回包，顺序倒置时配对错乱
    - 修法：分组器收 toolResult 时按 `msg.toolCallId` 找对应 toolCall step 挂上去；找不到再 fallback 到末尾。直播路径同步加按 id 索引
    - 数据层已就绪（step 已带 `toolCallId`），就差查找逻辑

3. **`phase: 'update'` 流式工具增量结果接住**
    - 现状：`agent-stream.js` 没有 `phase === 'update'` 分支，partialResult 整段被吞
    - 触发：长跑工具（bash 长命令、大文件操作）会一边跑一边推 partial
    - 修法：按 `toolCallId` 找回对应 toolCall step（与 #48 共用索引），把 `partialResult` 累计到 step 上的某字段；渲染时优先显示最新 partial，result 到来后替换为终态



## AddClawPage SSE 改造遗留（2026-05-05 deep review 发现）

1. **`AddClawPage.startBinding` 无 in-flight guard，重复点击可能并发两次创建绑定码**
    - 现状：`startBinding` 没有"上一次还没结束就忽略本次"的开关；用户快速双击"重新开始"会派出两次 `createBindingCode`，后到的响应会覆盖先到的 `bindingCode`，先到的码变孤儿（仍然在服务端有效，直至自然过期）
    - 注意：本问题在改造前的轮询版本同样存在，本次 SSE 改造未引入也未放大；归类为预存
    - 修法（可选）：加 `inflight` 标志或 generation token 序列化两次调用；或简单地按钮 `disabled` 直到上次完成

2. **`AddClawPage.captureBaseline` 无超时，SSE 始终未连通时页面永久卡 "preparing"**
    - 现状：进页面后 `captureBaseline` 等 `clawsStore.fetched` 翻 true 才放行；若 SSE 永远不连通（极少：服务端可达但 SSE 路由挂掉），spinner 永远不消失
    - 现实影响低：SSE 是整个 authed 区域的命脉，SSE 死意味着 claws 列表/状态/解绑通知都不工作，用户感知到的不是"加 Claw 卡住"而是"整个 app 都不对劲"
    - 修法（可选）：加几秒超时，超时 → 走 loadError 错误态展示 retry 按钮；或者直接 fallback 到 `listClaws()` 一次拿底子

## ChatPage 触屏下拉历史 deep-review 发现的预存问题（2026-05-06）

来源：触屏下拉加载历史 + `__loadMoreHistory` race 加固 deep review。下列条目本次未修。

1. **`__loadMoreHistory` 切走再切回同一 store 实例时的 race 残留**
    - 现状：本次 race 加固用 `chatStore === targetStore` 身份比对区分"是否切走"。chatStoreManager 内同 chat 复用同实例——用户切到 B 又切回 A，A 的 store 仍是同一对象。如果旧 A 加载尚未醒来期间用户在 A 又主动下拉触发新加载，旧 A await 醒来时 race guard 不会命中，会用旧 prevScrollTop / prevHeight 测量值改 scrollTop；finally 也会因 store 一致而清掉新加载的 `__loadingHistory` 锁，可能导致后续双发
    - 触发条件极窄：切走 → 切回同 store → 期间用户主动再下拉 → 旧加载比新加载更晚醒来；本次修法前后表现一致（旧版本同样错），不是本次引入
    - 修法方向：把 store identity 比对换成 per-call token：`__loadMoreHistory` 入口 bump `__loadToken`，await 后比对 token，finally 也只在 token 匹配时清锁；可彻底覆盖"切走切回 / 同 store 多次重入"等所有路径
    - 本次只补到"切走 → 不动新视图 + 不误清新锁"层面（占绝大多数真实场景）；token 改造留待后续

## 一阶段 RPC 调用方对 ok=true+payload.status='error' 的协议演进保险（2026-05-07）

**发现日期**：2026-05-07
**关联 commit**：fix(ui): notify on accepted-then-failed agent run（"模型不可用静默失败" 修复）

来源：本次"agent run accepted 后失败静默吞掉"修复时，调研 + codex-rescue 评估出的同类潜在 bug。OpenClaw 协议允许一阶段 RPC 下发 `ok=true + payload.status='error'/'timeout'`（业务级失败终态），但 UI 当前 `conn.request` 一律 resolve，让消费者直接当成功处理。

**当前实测不会触发**：上游 `agent` 主 RPC 是"双保险"（同时下发 `ok=false + payload.status='error'`），其它 OpenClaw 上游 method 大概率也是同样的设计风格。本次只在 `__onRpcDone` 里加了防御性分支，覆盖 `agent` 单点。下面这些是"协议未来演进或上游漏发 ok=false 时" UI 才会踩到的潜在隐患——影响是消费者把 status='error' 当成"空结果"静默处理。

修复方向：调用点 resolve 后增加 `if (result?.status === 'error') throw new Error(...)` 或类似分支；或者后续重构 `conn.request` 加白名单机制（仅对真正依赖 status 的 method 如 `agent.wait` 保留 resolve 语义）。

1. **`chat.history`** — `chat.store.js:353`。status='error' 时 `currentSessionId` 被静默置空，影响后续历史加载和 sid 比较判定
2. **`sessions.get`** — `chat.store.js:314, 404`。status='error' 视为空成功，会把已有 messages 清空
3. **`sessions.list`** — `sessions.store.js:225`、`dashboard.store.js:190`。status='error' 让会话列表/dashboard 数据归零
4. **`coclaw.chatHistory.list`** — `chat.store.js:1389`。status='error' 截断/清空历史分页
5. **`coclaw.sessions.getById`** — `chat.store.js:460, 1448`。status='error' 把 topic 消息清空
6. **`coclaw.topics.list/delete`** — `topics.store.js:81/206`。delete 只校验 `result.ok`，status='error' 下会误删本地 topic
7. **`coclaw.files.*`** — `services/file-transfer.js:85/99/110/121`。列表和写操作都不校验 payload 中的错误状态
8. **`coclaw.info.patch`** — `views/ManageClawsPage.vue:393`。重命名在任何 resolved payload 后都乐观应用
9. **`agents.list`** — `agents.store.js:128`。status='error' 把 agent 列表标为"已加载但为空"

**关联 deep design**：可考虑由 `claw-connection.js` 在协议层加 status 识别 + 通过 method 白名单豁免（`agent.wait` 必须保留），把这套逻辑收拢到一处而非散布在各调用点。

10. **`agent` run 取消 (cancellation) 与"自然完成"语义混淆**
    - 现状：上游对"用户取消"走 `ok=true + payload.status='ok' + result.meta.aborted=true`（见 openclaw-repo `agent.ts:330` 用 `result?.meta?.aborted` 判断）。UI 当前 `__onRpcDone` 走 `endReason='rpc'` 不读 meta.aborted，"用户主动取消"和"自然完成"被混为一谈
    - 影响：诊断日志、analytics、UI 状态展示无法区分两类终态
    - 修复方向：`__onRpcDone` 读 `rpcResult.result?.meta?.aborted`，true → endReason='rpc-aborted'；ChatPage 不 notify 但日志区分

11. **`coclaw.agent.abort` 用 `result.ok` 当业务标记** — **已评估保持现状（2026-05-24 复核）**
    - 现状：与协议层 `ok` 同名不同义（前者是插件本地业务返回，后者是 RPC 协议层，已被 ClawConnection 解包）。源码层 `respond(true, { ok: ... })` 已经把两层在同一表达式上隔离，实际阅读无歧义
    - 评估结论：改名跨 plugin+ui，涉及 1 处 plugin handler + 5 处 return + 1 处 UI 读 + 24+ 处测试 mock；纯命名洁癖无功能 bug，违 CLAUDE.md "非需求不重命名" 原则
    - 缓解：`agent-abort.js` JSDoc 已写明 shape；可在 `chat.store.js:1045` 调用点加一行行内注释点明"此 ok 是 abort 业务语义，非 RPC 协议 ok"

12. **协议偏离时 error/summary 是 object 形态显示成 `[object Object]`**
    - 现状：`agent-runs.store.js:404` 与 `chat.store.js:1133` 的 `String(raw)` 兜底能保证 toast 不丢 description，但若 `summary`/`error` 是 object（协议偏离），用户看到的是 `[object Object]` 而非可读内容
    - 触发条件：当前 OpenClaw `chat.ts` / `agent.ts` 的 error/summary 都是 string，不会触发
    - 修复方向：换 JSON.stringify 兜底（含循环引用 try/catch），让协议偏离时至少给出 raw JSON 而非 `[object Object]`。属"可读性增强"，非阻塞

## 测试场景补强 review 中发现的预存 / UX 增强项（2026-05-07）

**发现日期**：2026-05-07
**关联 commit**：c2a3e46 "fix(ui): silence error toast when user cancels and upstream returns error"（测试场景补强 deep-review）

1. **chat 切换期间 in-flight sendMessage resolve → `__tryGenerateTitle` 落到错的 chat**
    - 来源：2026-03-17 引入 Topic 管理 feature 时模式就存在，与 bc13c96 / c2a3e46 无关，是预存 bug
    - 现状：`ChatPage.vue:754` `__tryGenerateTitle` 用 `this.chatStore`，未走入口快照 `targetStore`。用户在 chat A 上发送、await 期间切到 chat B（也是 topic），sendMessage 落地后 generateTitle 被基于 chat B 的 topicId/messages 触发
    - 影响：chat B 可能还没 send 过任何消息，让 LLM 给空 chat 起标题，结果是垃圾或失败
    - 修复方向：`__tryGenerateTitle(targetStore = this.chatStore)`，两处调用点（`ChatPage.vue:631`、`:737`）显式传入 `targetStore`；同时把 `!this.isTopicRoute` guard 改为 `!targetStore?.topicMode`（topicMode 是 store 属性，与当前路由无关）
    - 测试：chat 切换期间 sendMessage resolve → generateTitle 调用 with targetStore 的 topicId/clawId

2. **失败 toast 文案 generic（无 chat 来源）→ unmount/chat 切换后用户难判归属**
    - 现状：`ChatPage.vue:651` `__notifyRunFailed` 弹 `chat.errRunFailed`（"Agent run failed"），不带 chat / topic 名称。用户在 chat A 上 send 后切到 chat B，sendMessage 落地弹的 toast 看起来像 chat B 的失败
    - 影响：UX 困惑，用户难定位失败来源；尤其多 chat / 多 topic 并发使用场景
    - 修复方向：toast description 前缀加 chat / topic 名称（如 `[Topic 标题] FailoverError: ...`）；或 toast 加 "Open" 按钮跳回 source chat。属 i18n + UX 改造，需统一其它失败 toast（如 `__sendErrorMessage`）一起规划

## agent run 终态后 streamingMsgs 接管策略缺陷（X4 课题，2026-05-08）

**发现日期**：2026-05-08
**关联会话**：`tmp/agent-run-fail-notify-deep-review--clear-dump.md`
**关联 fix（止血）**：X1 修法 — `loadMessages` 成功路径加 ended-run dropRun 兜底（解决占位永久残留 / "思考中"赖着不走的现象）

来源：RTC 真断 → "思考中"占位卡死 bug 的修法定位过程。X1 止血方案落地后 UI 行为已正常（占位最终会被 server 持久化版本接管，状态变"已思考 X 秒"），但 X1 本身吃一个**根本性的时序赌博**，需作为单独课题彻底修。

### 问题本质

`run.streamingMsgs` 当前是 partial reply 的"前台显示载体"——`dropRun` 一调，UI 上的内容立刻消失。X1 / register 抢占 / codex 候选 2（直接 dropRun）都共享这个特性：**让位给 server 持久化版本**。

如果 server 这边还**没**把这次 run 的内容落到 sessions（典型场景：RTC 真断时 plugin 那边 run 仍在跑、还没 lifecycle:end → 没机会做 final flush；或 plugin 那边的 sessions 持久化对 partial 内容根本不会保存），那么 `dropRun` 就是单方面把内容**清空**——partial reply 消失，"已思考 X 秒"也无从体现。

X1 已经把窗口缩到最小（至少等 reload 成功），但没消除这个赌博。

### 触发场景（X1 落地后仍存在）

- RTC 真断后 PC 重建成功 → `loadMessages` 拉到 server 数据（**不含**这次 run 的 partial reply，因为 plugin 没机会落库）→ X1 dropRun 老占位 → 屏幕上 partial reply 消失
- `loadMessages` 期间用户发新消息 → `register` 走"新 run 抢占老 run"路径 → `__cleanupRun` 清掉老 streamingMsgs → 同样依赖 plugin 是否已落库才能保住 partial reply

### 修复方向（X4）

把"占位"和"成品"分两层：

- run 终态那一刻**不**直接删 streamingMsgs，而是把 `_streaming=true` 翻成"已冻结"标记 → UI 立刻显示成"已思考 X 秒 + 已收到的内容"，按钮消失（`isRunning` 仍翻 false）→ 用户感知"完成了，内容定格在这里"
- 等 `loadMessages` 成功 **且** server 数据里**含**这条 run 的产物（按 `anchorMsgId` / 时序匹配）→ 才用 server 版本替换冻结版本，平滑过渡
- 如果 server 始终不收录（plugin 端因 RTC 真断没机会落库）→ 冻结版本永远留在屏幕上，partial reply **绝不丢**

### 影响面

X4 触及面比 X1 广，需要重新评估：
- `streamingMsgs` 的语义（从"流式占位"扩展为"流式占位 + 终态冻结快照"）
- `allMessages` 的 merge 规则（冻结快照如何与 server 持久化版本去重 / 替换）
- "何时算被 server 接管成功可以丢冻结版本"的精确判定（依赖 `anchorMsgId`、可能还需要 plugin 侧给 run 的产物加显式 marker）
- `register` 的"新 run 抢占老 run"路径是否需要保留冻结版本（理论上应该保留——抢占不该丢老 run 的内容）

实施前需派 codex-rescue 做副作用评估。

### 暂缓理由

- X1 止血已让"思考中赖着不走"这个最显眼的现象消失，UX 主问题解决
- partial reply 丢失的概率取决于 plugin 持久化时序，实际线上发生频率待观察
- 改面较大、需协调 plugin 侧 anchor 协议，作为独立课题排期更合适

## Web Agent hide-from-recent deep-review 发现的非阻塞项（2026-05-10）

来源：commit `1f1edc3 feat(ui): add hide-from-recent action on Web Agents list` 的 4 路并行 codex-rescue review。下列条目本次未修，登记跟踪。

1. **MainList 行内 actions trigger 在键盘 Tab 焦点上不可见（预存模式问题）**
    - 现状：`MainList.vue:107` `.agent-actions`、:152 `.web-agent-actions`、:188 `.topic-actions` 均用 `opacity-0 group-hover:opacity-100`。键盘 Tab 焦点落到 trigger 按钮时按钮仍 opacity=0 不可见，仅鼠标悬浮 + 触屏 always-visible 路径覆盖
    - 影响：a11y 不友好；键盘用户看不到当前焦点位置
    - 预存：自 `AgentItemActions` / `TopicItemActions` 引入即如此，本 commit 新加的 `WebAgentItemActions` 沿用同一模式，未引入也未放大问题
    - 修法方向：给三个 actions 类一并加 `focus-within:opacity-100` / `group-focus-within:opacity-100`（或在 `<style scoped>` 的 hover-none media query 旁加 `:focus-within` 规则）

2. **`recordClick` 与 `hide` 并发 fire-and-forget POST 请求乱序到达 server 时数据库与本地不一致**
    - 现状：`web-agents.store.js:128` `recordClick`、:142 `hide` 各自走 fire-and-forget POST，无串行或乐观时间戳协议；如果 hide 先 fire、click 后 fire，但 server 收到顺序倒置（click 先到、hide 后到），server 最终状态是 hidden；本地 lastClickedAt 比 server 新，新的 merge 规则会信任更晚的 click 让本地显示为可见，但下次任何客户端 loadAll 看到的是隐藏
    - 触发条件：用户先 hide 再立即从 picker 点开同一 agent，且两次请求的 server 处理顺序与发起顺序倒置；窗口在 RTT 量级（毫秒级）。用户可点 picker 再点该 agent 一次自愈
    - 修法方向：a) store 内对同一 id 的 hide/click 串行（promise chain per id）；b) 或在 POST 里带客户端时间戳，server 比较时间戳决定胜出
    - 影响小、触发极窄，登记跟踪

## 下拉菜单与列表项 trigger 菜单统一迁到 UDropdownMenu

**发现日期**：2026-05-10
**关联讨论**：MainList 重组（添加 Claw / 添加 Web Agent 入口三处铺设）

来源：本轮 MainList 重组讨论中确认，窄屏 capacitor header 的 `+` 改下拉菜单时，沿用了项目现有 "MainList 三点菜单同款样式" 即 `UPopover + 自绘列表`（如 `TopicItemActions.vue` / `AgentItemActions.vue` / `WebAgentItemActions.vue`）。这套实现先于 Nuxt UI 4 `UDropdownMenu` 引入，本质就是下拉菜单，应统一迁移。

- 现状涉及位置（至少）：`TopicItemActions.vue`、`AgentItemActions.vue`、`WebAgentItemActions.vue`，以及本轮新增的窄屏 header `+` 下拉
- 修复方向：统一替换为 `UDropdownMenu`（参考 `nuxt-ui` skill 中的标准用法），保持现有 a11y / 键盘 / 移动端可点击区域等行为不退化
- 收益：a11y 现成（焦点管理、roving tabindex、`role="menu"`）；样式集中由全局 `appConfig` 控；本地不再各自维护 `UPopover` 自绘 hack
- 本次不动，避免与 MainList 重组叠加风险

## remote-log 架构二次简化候选：单 FIFO + 消费端截批（2026-05-13）

**发现日期**：2026-05-13
**关联讨论**：S2 二次 deep-review 后的重构方案讨论

来源：S2 重构方案讨论中，确认更彻底的抽象方向。当前重构（生产端 ring → 封批 → pending 队列 → 消费端 shift 发送）保留了"ring + pending"两层分层；二次简化可把两层折叠成单一 log item FIFO，由消费端按需截批。

- 当前分层语义：
  - `__ring`：未封批的草稿；`__pending`：已封批的 batch 队列（batch 一旦封批 seq/logs 不再变动）
  - 分层让"批内容 immutable"通过结构本身保证，可读性好
- 二次简化方案：
  - 单一 FIFO 队列存 log item（`{ ts, text }`）
  - 消费端从队头 splice 最多 100 条形成 batch，seq 推迟到"准备发"那刻分配
  - drop oldest 颗粒度变细（按条丢，不再整批 100 条一起丢）
  - 5 秒 debounce 从生产端搬到消费端：消费端队列不足 100 条时 `await sleep(5s)` 兜底，期间被新 log 唤醒可立即检查
- 收益：
  - 减少一个状态字段（合并 ring/pending）+ 一个方法（`__pack`）
  - 异常路径下"重试期间累积的小批合并"自然发生，不需要特意写合并逻辑
- 实现要点：
  - 需要"够 100 立刻唤醒 + 不够等 5s"机制，方案：(a) 两个 AbortController（一个 stop / 一个唤醒），消费端 `Promise.race([sleep, wake])`；(b) fire-and-forget 重入：log 进队 + kick，setTimeout 5s 后再 kick 自己
  - drain 多一个"队列非空但未到 100 也未到时间"的等待态，测试需要钉住该状态
- 何时考虑做：
  - 若生产中观察到"重试期间小批堆积发送"现象明显
  - 或下一次涉及 remote-log 结构改动时（避免反复改架构）

## 身份纪元 AbortController：统一处理 logout / re-login 在飞请求

**发现日期**：2026-05-13
**关联 commit**：fix(web-agents): open list to anonymous users and clear it on identity change

**起因**：web-agents 匿名门户化 deep-review 走了三轮才稳，根因是"store 全局长寿命 + 异步任务跨身份切换"。本次给 `web-agents.store.loadAll` 加了局部 epoch 守护补丁，但同类问题在其它 store 上还会反复出现（files/agent-runs/topics/sessions/dashboard 都有"登出时在飞响应回写到刚清空的 store"的潜在风险）。

**目标方案**：身份纪元绑 AbortController。

- 在 `services/http.js` 增加一个 session-scoped controller 模块：暴露 `currentSignal()` / `abortSession()` / `rotateSession()` 三个 API
- 所有 `axios.get/post/...` 调用透传 `currentSignal()` 给 axios 的 `{ signal }`；axios v1+ 原生支持
- claw-rpc 同样接入（如有独立 AbortController 路径需评估）
- `auth.store.logout` 链最前面 `abortSession()`，登出链其它步骤照常跑（不需要 join）
- `auth.store.login` / `register` 成功分支 `rotateSession()` 起新一茬
- 各 store 的 catch 里识别 AbortError 静默跳过

**收益**：
- 替代本次加的 `_resetEpoch` 守护（webAgents）
- 一次性解决全仓库"登出时在飞请求"类问题
- 不需要每个 store 维护自己的 reset / epoch / dedupe-on-identity 逻辑

**已知边界**：
- abort 不能拦截"响应已 resolve 但 user code 还没派发"的极窄微任务窗口；可接受（实际几乎不触发）或在写状态前补一道身份核验作为兜底
- SSE / WebSocket 不走 signal，但已有独立 disconnect 路径，不动
- fire-and-forget 类调用（recordClick / hide / remote-log）的 server 端可能仍处理那次写入，client 端忽略即可，符合 fire-and-forget 语义

**改造范围**：基础设施 ~30 行；调用点逐个加 `signal` 参数；各 store catch 加 AbortError 识别。建议单独排期，不混进 bug 修。

**主流参考**：
- React Query / TanStack Query 的 `QueryClient.cancelQueries`：query key 维度的取消
- SWR 的 mutation abort：用户级生命周期 cancel
- Axios 文档：`AbortController` + `axios.isCancel`
- Apollo Client 的 `clearStore` / `resetStore`：登出时清缓存 + abort 在飞 query
本次场景与上面这些库的"身份切换时清缓存 + 取消在飞"模式同源；可在调研阶段对照它们的接口设计敲细节。

## 全仓库 `_MS` / `Ms` 后缀清扫

**发现日期**：2026-05-13
**关联 commit**：refactor(ui): rewrite remoteLog with producer/consumer pattern and AbortSignal

来源：remote-log 重构落实了「JS 时间常量默认 ms 单位，无需后缀」规则（memory `feedback-ms-suffix-convention`）。本次 scope 锁定 `remote-log.js` + 测试，未触其它模块。

- 待清扫面（grep `_MS\b\|Ms\b` 摘录）：
  - `ui/src/stores/chat.store.js`：`POST_ACCEPT_TIMEOUT_MS` / `CANCEL_TICK_MS` / `RPC_GRACE_MS` / 注释 + JSDoc 里的 `durationMs`
  - `ui/src/utils/dc-chunking.js`：`ORPHAN_REMOTE_LOG_WINDOW_MS`
  - `ui/src/services/file-transfer.js`：`READY_TIMEOUT_MS` / `DEFAULT_CONNECT_TIMEOUT_MS` / `formatTransferLog(bytes, durationMs)`
  - `ui/src/utils/agent-stream.js`：参数 `timeoutMs`
  - `plugins/openclaw/src/auto-upgrade/worker-verify.js`：`CMD_TIMEOUT_MS`
  - 其它（agent-runs.store.js / claw-connection.js / 各组件 props）按需 grep
- 建议拆按模块独立 PR 推进（chat.store 一个、file-transfer 一个、plugin 一个），避免大动整改
- 注意保留两类带单位描述的场景：
  - JSDoc 参数说明里的 "ms"（单位口径，不是后缀）
  - 局部变量描述如 "5 秒" / "30 秒"（中文场景按上下文）

## 大 session 一次性渲染卡顿（coclaw.sessions.getById 解除 500 上限后）

**发现日期**：2026-05-19（getById fallback + 上限修复 deep review 综合实例识别）
**关联 commit**：fix(openclaw-plugin): include .deleted archives in getById fallback and lift 500-message cap

**问题**：`plugins/openclaw/src/session-manager/manager.js` 的 `coclaw.sessions.getById` 拿掉默认 500 上限后，`chat.store.js` 两处调用（`__loadTopicMessages` :476 / `loadNextHistorySession` :1501）都不传 limit，会一次性把整条 transcript 塞进 `this.messages`，再由 ChatPage 的 `v-for` 全部铺到 DOM。对几千条消息的长 session，渲染开销与内存占用都会显著上升；返回值里也没有 `total`，所以无法做"加载更多"分页提示。

**为什么本期未修**：本次修复 scope 只在 plugin 一侧（去掉历史的 500 静默截断），UI 改动要引入虚拟滚动 / 分段加载是独立大题。

**修复方向**：

- 短期：UI 在 `loadNextHistorySession` 处按段加载（一次只渲染一段），用户拉到顶时再拉下一段；同时把 `getById` 入参里的 `limit` 用起来（传 e.g. 500）作为兜底
- 中期：引入虚拟滚动（如 `@tanstack/vue-virtual`）替换 `v-for` 全量渲染
- 关联 plugin 侧候选：`getById` 在调用方传了正 `limit` 时改成 tail-only 解析（从文件末尾倒着读 + 行边界扫描），避免一次性 `readFile` 整个 JSONL 后再 `slice(-N)`——见 `plugins/openclaw/TODO.md` 同名条目

## `InstanceOverview` 组件已写好但未挂载（monthlyCost 数据丢失）

**发现日期**：2026-05-22
**关联讨论**：评估 issue #234（Claw 详情页 Token 成本面板诉求）

来源：issue #234 评估时排查 ManageClawsPage 当前 token / cost 覆盖度。

- 现状：`src/components/dashboard/InstanceOverview.vue` 写有完整的实例总览 + `monthlyCost` 渲染逻辑，对应单测 `InstanceOverview.test.js` 也覆盖；但全仓 grep 无任何业务页面 import 它，组件实际未挂载
- 数据已就绪：`dashboard.store.js` 在加载 dashboard 时已经调用 `usage.cost` RPC 并把结果写入 `entry.instance.monthlyCost`（也走完了 `Promise.allSettled` 失败兜底）
- 影响：「本月花费」数据虽然每次进 `/claws` 都被拉回来，但用户在 UI 上看不到，相当于白调一次 RPC + 白做一份兜底
- 修复方向：在 `ManageClawsPage.vue` 的合适位置（建议作为「状态摘要栏」下方、claw 卡片列表上方的全局总览区）挂载 `<InstanceOverview :instance="...">`，把 dashboard 里任一 claw 的 `instance` 字段传入；多 claw 场景下决定是「展示首个 online claw」还是「按 claw 分卡片各自展示」需先讨论 UX
- 非阻塞但收益明确：5 ~ 10 分钟接线工作量，可单独 commit

## Tailwind 4 alpha 修饰符编译为 `color-mix()` 与浏览器基线冲突

**发现日期**：2026-05-23
**关联讨论**：issue #245「回到底部」按钮样式微调，dark 主题辨识度排查

**问题**：项目浏览器基线为 Chrome 90 / Edge 90 / Safari 15 / Firefox 90（`vite.config.js` `build.target`，UI workspace CLAUDE.md「浏览器兼容性基线」）。但 Tailwind 4 把语义 token + alpha 修饰符（如 `bg-default/80`、`bg-accented/80`、`bg-muted/60`、`ring-white/20`）统一编译成 `color-mix(in oklab, var(--ui-bg-xxx) 80%, transparent)`。`color-mix()` 各浏览器支持时间：

| 浏览器 | 支持 color-mix | 基线 |
|---|---|---|
| Chrome | 111+（2023.03） | 90 |
| Edge | 111+ | 90 |
| Safari | 16.2+（2022.12） | 15 |
| Firefox | 113+（2023.05） | 90 |

也就是说所有基线浏览器都跨不过这条线。

**已发布产物核实**：`dist/assets/index-*.css` 里 `color-mix()` 出现 **461 次**，项目实际上早已依赖该特性。用法主要分两类：
- 业务源码里 `bg-default/80`、`bg-accented/80` 等（FileManagerPage、ChatPage、MainList、ChatMsgItem 多处，及本次 ChatPage 回到底部按钮新增的 `bg-elevated/80` / `dark:ring-white/20`）
- @nuxt/ui 4 组件内部的预设样式

**影响**：基线内浏览器解析失败 → 整条 background-color / box-shadow declaration 被丢弃 → 元素呈无背景或父级继承背景。对回到底部按钮这类"半透明浮层"会退化为完全透明（仅 icon 可见，按钮形状消失），辨识度归零。但 dark/light 主题切换、文本颜色等绝大多数语义色不带 alpha 修饰符，不受影响。

**为什么本期未修**：本次任务只是按钮样式微调；项目已大量依赖 color-mix（461 处），单独修我们这个按钮意义不大。属于项目级浏览器基线策略问题。

**修复方向**：

- **方案 A：升基线**（推荐）。Chrome/Edge 111、Safari 16.2、Firefox 113 都是 2023 年发布，至 2026.05 已两年多。把 `vite.config.js` `build.target` 升到对应版本，与 UI CLAUDE.md 一并更新。Capacitor Android WebView 走的是系统 Chrome，主流 Android 6+ 设备早已升过 Chrome 111+
- **方案 B：在 `main.css` / appConfig 里禁用 `color-mix`-based 透明度**，统一用预定义的多档 token（如 `bg-elevated-soft` = 预生成的 80% 混色实色）。改动面大，且会失去任意 alpha 灵活性
- **方案 C：保留现状，明确"基线浏览器下浮层/hover 透明度降级为无背景"是已知行为**，文档化

## UI 低风险批 deep-review 发现的预存问题（2026-05-24）

**发现日期**：2026-05-24
**关联**：UI 低风险批 deep-review（commit 范围 `978573e..20ab951`，4 路 codex-rescue 综合实例发现）

1. **`__validateRoute` 在 topic 已被删除时不把用户推走**
   - 现状：`ChatPage.vue:1037-1044` `if (this.isTopicRoute)` 分支只在 `topic` 存在时检查 ownerBot；若 `topicsStore.findTopic(currentSessionId)` 返回 null（claw 被 unbind → `claw-lifecycle.js` 同步删除该 claw 的所有 topics），代码直接 return 什么都不做。结果用户停留在 `/topics/<被删 id>` 路由上，`chatStore` computed 返回 null，整页空白
   - 触发条件：用户当前看着某 topic 时，从另一端把该 topic 所属 claw 解绑（SSE claw.unbound 到达）
   - 修法方向：`if (this.isTopicRoute)` 分支补 `if (!topic) return this.__exitChat(this.$t('chat.clawUnbound'));`（或更精准的 topic-deleted 文案）；同时确认 `__validateRoute` 调用时机能覆盖 SSE 触发的 topics 删除（chat-lifecycle 改动 topicsStore 后是否会触发某个 watcher 调用 `__validateRoute`）

先讨论方案 A 是否可推进，再决定是否要兜底。

## ProgressRing 暗主题与 Android 真机肉眼验证（顺延，需手工）

**发现日期**：2026-05-23
**关联讨论**：task `ui-todo-tests-cleanup` S6 收尾。原 ProgressRing 后续优化 §2 已通过 Playwright 360px 截图核对（PASS：长文件名 truncate、ProgressRing 36px 与取消按钮在 360 视口下不溢出，详见 `/tmp/coclaw-progressring-screenshots/`）。剩余 §3/§4 涉及人眼或真机不能由 agent 完成，登记在此等手工执行。

1. **暗黑主题对比度肉眼验证**
   - 现状：`bg-default/60` 覆层 + `stroke-muted` 轨道 + `stroke-primary` 弧的暗模式视觉效果需人眼核对。Playwright 给 `<html>` 加 `dark` class 抓的截图与默认主题视觉一致，无法替代肉眼判定
   - 修复：dev 启动 + 在 UserSettings 切换主题，对照确认 muted 轨道与 primary 弧对比度；若 muted 在暗下与 primary 对比不足，改用 `stroke-elevated`

2. **真机 Android WebView 验证**
   - 现状：`stroke-dashoffset` transition + `animate-spin` 在 Android Chrome 90+ WebView 表现未实测
   - 修复：Capacitor 构建后在 Android 真机/模拟器跑一次完整上传流程，确认动画 / 弧长过渡正常

## AddClawPage：SSE 一直未推首份 claw 快照时的用户引导

**发现日期**：2026-05-24
**关联背景**：980c9a2 曾经加过一条"15s 超时 → REST `listClaws()` 兜底"路径来缓解此场景，2026-05-24 已撤回——理由是项目里 claws 数据全靠 SSE 推送，单独让本页走 REST 自救违背全局架构（其他页面同样瞎），且该 fallback 自身又引入了快速离页留孤儿绑定码的新风险。

- 现状：`captureBaseline` 在 `clawsStore.fetched=false` 时无限等待 SSE 翻 true，期间页面停留在 "Preparing..." spinner。如果 SSE 通道始终未建立（登录态异常 / 网络中断 / server SSE endpoint 故障），用户感受到"页面卡住，无任何提示"
- 修复方向（待设计）：
  - 给等待加一个软超时（比如 15–20s）转入显式错误态，提示"未能连接到服务器，请检查网络或重试"，复用现有 `loadError` + "重试" 按钮的状态机
  - 或者在更上层（App 级）surface SSE 连接状态徽标，由全局信号驱动，AddClawPage 只读不自救
  - 不要再走 REST 兜底——会回退到撤销前的同一坑
- 优先级：低；此场景在真正现网命中很窄（SSE 接通本身可靠性较高），不阻塞产品迭代

