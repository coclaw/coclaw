# UI TODO

非阻塞改进点登记。每条记录"问题 / 修复方向 / 关联 commit"。

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

2. **窄屏布局回归验证**
   - 现状:`FileUploadItem` 改为"右侧并列 ProgressRing(36px) + 取消按钮"后,360px 视口下文件名截断未实地验证
   - 修复:Playwright 对 FileManagerPage 上传/下载 running 态在 360 宽截图,确认文件名截断与按钮可点击区域

3. **暗黑主题对比度肉眼验证**
   - 现状:`bg-default/60` 覆层 + `stroke-muted` 轨道 + `stroke-primary` 弧的暗模式视觉效果未现场确认
   - 修复:dev 启动 + 切换主题验证;若 muted 在暗下与 primary 对比不足,可考虑 `stroke-elevated`

4. **真机 Android WebView 验证**
   - 现状:`stroke-dashoffset` transition + `animate-spin` 在 Android Chrome 90+ WebView 表现未实测
   - 修复:Capacitor 构建后在 Android 真机/模拟器跑一次完整上传流程

### 测试增强

5. **ChatInput.test 改用 ProgressRing stub**
   - 现状:`ChatInput.test.js:429` `text().toContain('60%')` 走真组件,依赖 `showValue` 默认值
   - 修复:与 FileUploadItem/FileListItem 测试一致,加 `ProgressRingStub` 暴露 `data-value`,断言 `attributes('data-value') === '0.6'`

6. **FileListItem.test retry 按 icon 选**
   - 现状:`FileListItem.test.js:147-157` 用 `buttons[0]` 按 DOM 顺序选,模板调整后会静默失败
   - 修复:`buttons.filter(b => b.attributes('icon') === 'i-lucide-rotate-cw')[0]`

7. **ProgressRing color fallback 路径覆盖**
   - 现状:`STROKE_CLASSES[this.color] || STROKE_CLASSES.primary` 的 `||` fallback 是 dev 模式 validator 警告后的兜底,无测试
   - 修复:用 `config.global.config.warnHandler` 抑制 validator 警告,测 `color: 'bogus'` 走 fallback

8. **ProgressRing 响应式切换覆盖**
   - 现状:未测试 `value: 0.5 → null` 时 transition class、aria 属性、span 显隐的切换
   - 修复:`wrapper.setProps({ value: null })` + `await wrapper.vm.$nextTick()` + 断言

9. **__fileProgress "键存在但 progress 字段缺失" 边界**
   - 现状:`fileUploadState[id]?.progress ?? 0` 兜底,但测试只覆盖 unknown key 路径
   - 修复:补一个 `{ f1: { status: 'uploading' } }`(无 progress 字段)断言返回 0

10. **dashArray 不定态精确值断言**
    - 现状:`ProgressRing.test.js:115` 只断言"含空格",无法防止 0.25 弧长被误改
    - 修复:精确断言 `${CIRC*0.25} ${CIRC*0.75}`

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

### 预存问题(非本次引入)

15. **ChatInput failed 上传文件卡片可能"恢复正常带叉号"**
    - 现状:`ChatInput.vue:51` 移除按钮 `v-if="!__fileStatus(f.id)"`;`fileUploadState[id].status === 'failed'` 时移除按钮重新出现,卡片视觉回到正常态,无失败提示
    - 修复:`failed` 态保留卡片但叠加红色覆层 + 重试按钮;或由 `chat.store` 立即清理 failed 文件

## Bug 1 修复 review 后续（lifecycle 抢跑 → "任务未完成"）

**发现日期**：2026-04-26
**关联 commit**：
- `39051af` fix(ui): wait for transcript persistence before dropping streaming overlay
- `f91014c` docs(openclaw-research): document agent run persistence timing and signal guarantees

来源：codex-rescue + Claude 双线 review。本节列出 review 中浮出但本次不动的疑似 bug / 优化点。

### 疑似 bug

16. **streaming overlay 永久残留 bug（DC 失联场景）** — 详见 [`ui/docs/streaming-overlay-stuck-bug.md`](docs/streaming-overlay-stuck-bug.md)
    - 触发条件极窄（≥3 分钟持续网络故障 + ICE restart 预算耗尽），用户能通过发新消息自愈，**暂不修复**
    - 文档涵盖：完整链路、关键事实核实（assistant 增量流是 cumulative、microtask 原子窗口）、4 个修法方案及影响面、源码锚点速查
    - 原 #31（`run.ended` 与 streamingMsgs 合并语义错位）属同一 bug 不同侧面，已合并入文档

17. **'rpc' 快通道遇到上游 persist 静默吞错时无诊断信号**
    - 现状：上游 `agent-command.ts:1130-1134`、`:1553-1557` 的 `persistCliTurnTranscript` / `persistAcpTurnTranscript` 用 `try/catch` 吞掉异常后继续 `respond(true, "ok")`。CoClaw UI 的 'rpc' 快通道（`chat.store.js:1388-1392`）拿到 res 帧后立即 `loadMessages` + `dropRun`，不校验 `hasTerminalAssistantAfter`。极罕见情况下用户会看到"任务未完成"且无 remoteLog
    - 修复方向：'rpc' 快通道也加 `hasTerminalAssistantAfter` 校验；不通过时打一条 `remoteLog('agent.run.persist-failed-rpc ...')`

### 文档 / 可观测性

18. **`agent-event-streams-and-rpcs.md` "强保证"措辞软化**
    - 现状：文档 §四.2 写"二阶段 res 帧一发出，transcript 一定已写完——这是源码层面的同步 await 链保证"。实际上游 persist 用 `try/catch` 吞错后仍会 respond，是"尽力保证"而非"强保证"
    - 修复：把"强保证"改成"persist attempt 已在 respond 前 await；若 persist 自身抛错，会被 log.warn 后继续响应"，并在 §五.1 信号汇总表的"transcript 已写完？"列把 RPC 二阶段从 "**是**（同步 await 保证）" 改成 "**几乎是**（persist 在 respond 前 await，但抛错会被吞）"

19. **`agent.run.persist-stale` remoteLog 维度补全**
    - 现状：`chat.store.js:1417` 只打 `endReason / runKey / elapsed=3s`
    - 修复：补 `runId / msgCount / anchorId / clawId`，并把 `elapsed=3s` 改成实际累计耗时（含两次 loadMessages 自身的 RPC 时间）

### 测试

20. **缺显式 'rpc' fast-path 命名测试**
    - 现状：本次新增 4 条测试都是 lifecycle 路径；'rpc' 路径只是被旧测试隐式覆盖
    - 修复：在 `chat.store.test.js` 加一条显式 `endReason='rpc' → 立即拉 + dropRun，无 sleep` 的命名测试

### 上线后观察

21. **3s 重试上限是否够**
    - 现状：`PERSIST_AWAIT_MS=1000` + `PERSIST_RETRY_AFTER_MS=2000` = 3s 上限，针对 pi 层 `appendFileSync` 的同步写盘已足够，但没 p99 实测数据
    - 行动：上线后观察 `agent.run.persist-stale` remoteLog 频率；高频则考虑指数退避或常量配置化（比如长 transcript / 慢盘场景）

## ICE-restart 代次号（restartGen）协议（跨 UI + plugin）

**发现日期**：2026-04-26（本批未实施，登记到此）
**关联 commit**：`fa42501` 提的 backlog（`rtc:restart-rejected generation-id design`）
**第 9 轮已落 UI 侧 partial 闭合**：`bd394fc` 闭合"旧 restart 已 close 后状态离开 restarting"子窗口；本条覆盖剩余的"旧 restart 已 close 后又进入新 restart"子窗口

22. **`rtc:restart-rejected` 加 `restartGen`，UI 收时按代次号 drop 旧 reject**
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

23. **`__resumeOnline` 入口缺 `claw.online` 防御 gate（红线 3 纸面差）**
    - 现状：红线 3 文档要求 5 处布点，`__resumeOnline` 入口当前只 gate 了 `_sigOffline`，没显式 gate `claw.online`
    - 亲自核实：4 个调用方（`updateClawOnline` prev=false 分支、`updateClawOnline` 同值 + rtcPhase=failed、`applySnapshot` Phase 3 toResume、`__resumeAllClawsForSigOnline`）全部过滤了 online=true → offline claw 不会进入，运行时不触发问题
    - 决策方向二选一：a) 补防御性 gate 落实红线 5 处布点；b) 修红线文档明确"`__resumeOnline` 入口由调用方契约保证 claw.online"

24. **`topics.store.createTopic` 缺 post-await `byId` re-check（ghost-topic-on-removed-claw race）**
    - 来源：commit 9ab962d round 24 backlog
    - 现状：`createTopic` 在 await 期间 claw 被 removeClawById 时，return 后仍可能写入 ghost 条目。窄窗口
    - 修法：post-await 加 `byId` re-check，被 evict 即放弃

25. **`claw-connection.setRtc` non-ready-RTC defensive-net test 缺**
    - 来源：commit 9ab962d round 24 backlog
    - 现状：测试覆盖未锁住"setRtc 收到非 ready 状态 rtc 时不应被传播到 isReady"的契约
    - 修法：补单元测试

26. **`__ensureRtc` connected early-return 当 `rtc.state==='connected' && !rtc.isReady`**
    - 来源：commit 54b609d round 20 backlog
    - 现状：`__ensureRtc` early-return 看 state===connected，但 isReady=false 时 DC 实际不可用；窄窗口可能 short-circuit 错误判定
    - 修法待定：可能改 early-return 条件 + 重 init；需深入 review

27. **`setupAppStateChange` 直接回调捕获，测试注入需要清理**
    - 来源：commit 665f0e7 round 22 backlog
    - 现状：测试用 vi.doMock 注入有副作用残留风险；setupAppStateChange 直接捕获 App 引用而不是从工厂注入，单测覆盖被钳制
    - 修法：factor App reference for test injection，或 vi.doMock 用法收紧

28. **`isConnectingRtc` / `unreachableClaws` getter 语义在 sig offline + rtcPhase=building/recovering 期间不清晰**
    - 来源：commit 4ae005e round 19 backlog（"P2-5"）
    - 现状：sig offline 时 `rtcPhase` 可能仍是 building/recovering（pre-existing 残留），UI 看到的 isConnectingRtc / unreachableClaws 状态不直觉
    - 决策与 SignalingBanner UX 工作捆绑，等 UX 推进时一并处理

29. **`manualRetryUnreachable()` 不直接检查 `_sigOffline`（UX wart）**
    - 来源：commit 68d9f99 round 18 backlog
    - 现状：`manualRetryUnreachable` 是用户点"重试"按钮触发；sig 不通时仍会进入 retry 流程，看似无反应。UX 不友好
    - 修法：UX 层面在 sig offline 时 disable 按钮 + 提示文案；或 `manualRetryUnreachable` 入口加 sig gate + 反馈

## "刷新触发流式占位错位" fix 多维度 review 发现的预存问题（2026-04-30）

**关联 commit**：`807c300` fix(ui): advance streaming anchor on strip to keep refresh-during-run grouping correct

来源：第 1 + 第 2 轮 codex-rescue 多维度并行 review。这两条均**自 55212ea (2026-04-06) 引入 anchorMsgId 起就存在**，本次 fix 只解了"必现 refresh"主路径，未触及这两条；非阻塞登记。

30. **`!anchorId` 分支误 strip：当 server 返回历史 user 但当次 user 尚未持久化时，optimisticUser 被错误清掉**
    - 现状：`agent-runs.store.js` `stripLocalUserMsgs` 的 no-anchor 分支用 `serverMessages.some((m) => m.message?.role === 'user')` 判定 server 是否已持久化当次 user。但这条只检查"server 有任意 user 消息"，无法区分"老历史 user"和"当次 user"
    - 复现路径（窄但真实）：activate 失败 → `this.messages=[]` → 用户 send（anchor 计算为 null）→ 用户立刻刷新（赶在 OpenClaw 持久化 curr_user 前）→ server 仅返回 `[old_user, old_a]` → `some(user)` 命中 old_user → optimisticUser 被 strip → optimisticClaw 末尾追加，merge 进 old_a 的 botTask → **用户刚发的消息从 UI 消失，老对话戴上"思考中"**
    - 触发条件较窄：activate 必须先失败（少见），用户必须立即送消息且立即刷新（罕见）
    - 修复方向：
        - 方案 A：no-anchor 分支额外校验"server 那条 user 是否在锚点时间窗口之后"——但需要时间戳，且 anchor 是 id，不直接可比
        - 方案 B：在 `register` 时若 `anchorMsgId=null` 且 `optimisticUser.timestamp` 已知，记录一个 `runStartTs`；no-anchor strip 时只接受 `timestamp >= runStartTs` 的 server user
        - 方案 C：彻底改 anchor 语义为"时间戳锚点"而非"id 锚点"，规模较大
    - 必须配套补 chat.store + agent-runs.store 单元测试（"no-anchor + server 仅有历史 user 无 curr_user"场景）

31. **`run.ended` 与 streamingMsgs 合并语义错位** — 已并入 #16，详见 [`ui/docs/streaming-overlay-stuck-bug.md`](docs/streaming-overlay-stuck-bug.md)

## MainList agent 排序 deep-review 发现的预存问题（2026-05-01）

来源：MainList 排序 + 标签改造 deep-review。第 1 轮 codex-rescue 并发维度报告。该问题**自 sessions.store 引入 `_loadingPromise` / `_perClawLoading` 合流以来就存在**，本次重写（`chat.history` → `sessions.list`）只是沿用原合流模式，未触发但暴露出来。

33. **`_loadingPromise` 老 promise 的 stale finally 在 logout/同 id 重绑窗口可能误清替换 promise**
    - 现状：`sessions.store.js:121` 的 `_loadingPromise = null` 是**无条件清**，没有像 `_perClawLoading.set` 那样的"仅当 Map 当前条目仍是本 promise 时才清"identity guard
    - 时序：旧 `loadAllSessions()` 在飞 → logout 触发 `__resetSessionsInternals` 清内部状态 → 新 `loadAllSessions()` 写入新 promise → 旧 finally 跑到 `_loadingPromise = null` → 把替换 promise 也清了 → 下一次同时刻并发的 `loadAllSessions()` 不再合流，发起独立 RPC
    - 实际影响：极窄窗口 + 仅多发一次 RPC，无功能性故障
    - 修法：参照 `_perClawLoading.finally` 的 identity 比较模式：`if (_loadingPromise === p) _loadingPromise = null`
    - 非阻塞

## MainList 排序 deep-review 第 2 轮发现的预存问题（2026-05-01）

来源：commit f201b0a 上的第 2 轮 deep-review（5 路并行 codex-rescue + 1 opus 重派）。下列条目均与 f201b0a 改动无关，本次 review 中浮出。

34. **`agent-runs.store.runAgent` register 早于 chat 层 onAccepted → 极迟到 accepted 后产生 split-brain**
    - 来源：commit `44e3bf3` 引入 runAgent 抽象时即存在
    - 现状：`agent-runs.store.js:209-228` 内 onAccepted handler 先 `register(runId, ...)` + `__startWatcher`，再调 chat 层 onAccepted；chat 层 pre-accept 180s 超时（`chat.store.js:527`）已触发 → catch 已跑 → `preAcceptInvalidated=true` 短路 chat 层 onAccepted；但此时 agent-runs 已注册了真实 run，watcher 已起，`allMessages` getter 仍会把 streamingMsgs 合进 UI
    - 触发条件极窄：server 在 180s 后才 accept；通常 DC 早 reject 了
    - 实际影响：用户看到一条挂着的"流式消息"但 chat 层不知道存在；按 STOP 走 pre-accept 分支（设 `__pendingCancelIntent`），无 onAccepted 消费，UI 卡在 cancelling 状态直到自然终结或刷新
    - 修法方向：runAgent 的 onAccepted 在调外部 onAccepted 之前等其返回 sentinel，或外层加"chat 层已认定 pre-accept 失败 → 立刻 unregister run + abort RPC"通道
    - 配合 §"Bug 1 修复 review 后续" 的 #16 / #17 一并思考

35. **`loadAllSessions` 与 `loadSessionsForClaw` 同 claw 同时飞行可互相覆盖**
    - 现状：两套 dedup（`_loadingPromise` vs `_perClawLoading`）独立，同 claw 可有两个 in-flight fetch；`mergeFetchResults` 的"已查询 claw"路径直接以 fetch 结果替换（`sessions.store.js:291-299`），后完成的覆盖先完成的
    - 触发条件：用户切 claw 引发 per-claw 拉取与全量拉取叠加，且 fetch 完成顺序与发起顺序倒置
    - 实际影响：极短窗口的旧数据覆盖新数据；下次任意 sessions.list 触发即修正
    - 修法方向：两套 dedup 共用一个 (clawId → in-flight) 注册表，或合并环节按 fetch 发起时间戳决策

36. **claw 解绑后短时同 id 重绑期间，旧 fetch 结果可污染新 claw**
    - 现状：`removeSessionsByClawId` 清 `_perClawLoading` 但不清全局 `_loadingPromise`；旧 `loadAllSessions` 飞行中 → claw 解绑后短时同 id 重绑 → `mergeFetchResults` 的 `clawsById[bid]` 校验通过（新 claw 在）→ 旧数据被写入新 claw 空间
    - 触发条件：极窄；需在飞行中 + 同 id 重绑 + clawsById 已有新 claw 实例
    - 修法方向：`__doLoadAll` 的 results 处理环节加 claw 实例 identity 比对（不仅看 byId 是否有 entry，也看是不是同一个 claw 对象）；或 removeSessionsByClawId 同步给一个 epoch，旧 fetch 结果按 epoch 丢弃

37. **slash 命令期间点 STOP 留下 `__pendingCancelIntent` 残留 → `isCancelling` getter 误亮**
    - 现状：sendSlashCommand 期间 `sending=true` → STOP 按钮可见可点；`cancelSend` 走 pre-accept 分支（chat.store.js:781-789）设 `__pendingCancelIntent=true` 后返回 null。slash 路径既无 onAccepted 来消费这条 intent，`__cleanupSlashCommand`（line 1080-1094）和 slash catch 块也都不清；intent 残留到下次 sendMessage / sendSlashCommand 入口的 `__clearCancelling('superseded')` 才清掉
    - 实际影响：用户感知"点了 STOP 没反应"，且 slash 自然结束后期间 `isCancelling` 仍为 true（依赖 `__pendingCancelIntent`，line 168-170），可能影响其它依赖 getter 的 UI 反馈
    - 修法方向：a) UI 在 slash 期间 disable STOP 按钮（chatStore.__slashCommandType 非空时）；或 b) `__cleanupSlashCommand` 同步清 `__pendingCancelIntent`（slash 不可被服务端取消，intent 没有意义）

38. **`getActivity` 在 MainList 排序中 O(A×S) 线性扫描**
    - 现状：`sessions.store.js:42-50` `getActivity` 对每个 (clawId, agentId) 全量遍历 items；MainList 的 `agentItems` computed（`MainList.vue:264, 278`）对每个 agent 调一次，最坏 O(A×S + A log A)
    - 实际影响：几十条 item 内可忽略；多 claw 多 session 长期使用后可能延迟 MainList 渲染
    - 修法方向：sessions.store 内维护 `Map<clawId:agentId, item>`，getActivity O(1) 命中

## 输入区附件 per-chat/topic 隔离（方案 A''）deep-review 发现的非阻塞项（2026-05-03）

来源：4 路并行 codex-rescue review（3 路按维度切分 + 1 路综合）。本批主要 bug 已在同 commit 修复，下列为相关边角与预存问题。

39. **ImgViewDialog 直接复用 store 的 ObjectURL，store dispose 期间预览会裂图**
    - 现状：`ChatInput.vue:476-480` `previewImg(f)` 把 `f.url` 拷到 `previewImgSrc` 显示。若 LRU 淘汰 / 登出 / promote dispose 触发 `chat.store.dispose` revoke 该图片 url，dialog 仍持引用，浏览器看到 `blob:` 但实际无效，图裂
    - 触发：用户预览着图 + 同时触发 store dispose（10+ topics 时 LRU、登出、promote 流程）
    - 与本次方案的关系：附件归 store 管后，store dispose 路径增加，命中概率放大；但 dialog 与 store 解耦的修复是独立工作
    - 修法：dialog 打开时单独 `URL.createObjectURL(f.file)` 自建副本，关闭时自 revoke；外部 `f.url` 仅用于缩略图列表渲染
    - 设计 dump 已标注本项可同期顺手修，未在本次范围内

40. **`__handleNewTopicSend` 中 router.replace 失败时 oldStore 视图破图**
    - 现状：`ChatPage.vue:640-684` promote 之后 `newStore.inputFiles === oldStore.inputFiles`（同源数组）。若 `router.replace` 抛错（如 router guard 取消），catch 路径上 `targetStore` 已被赋值为 newStore，会调 `targetStore.clearInputFiles()`：循环 revoke 共享数组里所有图片 url 后再 `this.inputFiles = []`（重指向空数组）。但 oldStore.inputFiles 仍指向原数组（含已 revoke 的 url），ChatInput 看的是 oldStore，所有图片立即破图
    - 触发条件：仅 router.replace 抛错就足够（不需要 LRU 同时触发）。router guard 抛 false / next(false) / 守卫 throw 都算
    - 修法方向：catch 中检测 promote 已发生但 router.replace 失败 → 切断同源（先把 newStore.inputFiles 重指向独有空数组，再 dispose newStoreKey），然后在 oldStore 上做 clear+restoreFiles
    - 实际影响：本项目当前 router 配置下 replace 抛错的场景有限，但只要触发就视觉很差

41. **new-topic store 不入 LRU**
    - 现状：`chat-store-manager.js:33` get 仅对 `storeKey.startsWith('topic:')` 入 LRU。`new-topic:` 前缀不淘汰
    - 实际影响：极小——每个 (clawId, agentId) 组合最多一个 new-topic store；用户访问过的组合数 ≤ 数十量级；登出 disposeAll 兜底
    - 与设计 dump 偏离：dump 原写"new-topic 也入 topic LRU"，实现与之不一致；已在 chat-store-manager.js:33 处加注释说明保留当前行为的理由。如未来用户反馈附件累积内存压力，再考虑加主动淘汰

## 输入区附件 per-chat/topic 隔离 deep-review 第 2 轮发现的非阻塞项（2026-05-03）

来源：第二轮 4 路并发 codex-rescue review。本批未发现真必修业务问题（仅 2 处文档/注释偏差当场修复）；下列为发现的边角与预存问题，登记备查。

42. **`chatStoreManager.dispose()` 部分失败时 instances/topicLru 残留**
    - 现状：`chat-store-manager.js:86-95` `store.dispose()` 或 `$dispose()` 抛异常时，下面的 `instances.delete()` + `topicLru.splice()` 都跑不到，受害者会留在两个索引里
    - 已有部分缓解：`__evictTopics`（chat-store-manager.js:140-151）外层有 try/catch + 兜底硬清，但仅覆盖 LRU 淘汰路径；其它调用方（`commit()` 内的 dispose、`disposeAll`）未兜底
    - 预存问题：本次修复未改 `dispose()` 函数体；该问题在 ba3bf63 之前就存在
    - 修法方向：把 `instances.delete()` + `topicLru.splice()` 放进 finally，分别对 `store.dispose()` / `$dispose()` 各包 try/catch

43. **`promoteToTopic` 内部抛错时新建的 newStore 泄漏**
    - 现状：`chat-store-manager.js:62-83` 中 `this.get(newStoreKey, opts)` 已 instances.set 新 store；若后续 `newStore.activate({skipLoad:true})` 或 `inputFiles` 赋值抛异常，promote 函数抛出后 ChatPage catch 里 `targetStore` 仍是 null，无法 dispose 这个泄漏的 newStore
    - 现实概率：极低——`activate({skipLoad:true})` 是同步且短路的，正常路径不抛
    - 实际影响：泄漏 1 个 topic store + 其 inputFiles 中的 ObjectURL，登出 disposeAll 兜底
    - 修法方向：promoteToTopic 内部 try/catch，失败时 dispose(newStoreKey) 后 rethrow

44. **`__handleNewTopicSend` 各 await 后未检查组件已卸载**
    - 现状：`ChatPage.vue:626-684` 用户在 createTopic / router.replace / sendMessage 任一 await 期间返回 /topics 列表，函数仍继续跑——createTopic resolve 后 promote + router.replace 会强行把用户从 /topics 拽回到 topic chat 页面
    - 现实概率：用户点发送后毫秒级返回（如手机 back swipe）才能触发
    - 这是 Vue Options API + async router 的通用模式问题，不仅限于本次修复，但本次新增 router.replace 让它更明显
    - 修法方向：beforeUnmount 设 `this.__unmounted = true`，每个 await 后早返回 + 已发起的 newStore 主动 dispose

45. **`saveBlobToFile` 异常路径未 revoke ObjectURL**
    - 现状：`src/utils/file-helper.js:156-169` Web 端创建 ObjectURL 后 a.click → removeChild → revoke 是直链；中间任一步抛异常会跳过 revokeObjectURL
    - 预存问题：本次修复未触及该函数
    - 修法：用 try/finally 包住 DOM 操作部分，确保 revokeObjectURL 一定跑

46. **`procRecordedVoice` 绕过 MAX_UPLOAD_SIZE 校验**
    - 现状：`ChatInput.vue:449-460` 录音文件直接 `chatStore.addFiles([item])`，跳过了 `addFiles` 入口的 MAX_UPLOAD_SIZE 检查
    - 实际影响：录音受 MAX_RECORD_DURATION + audioBitsPerSecond 双重限制，理论上限约 1.2MB，远低于 1GB 上限，不会触发
    - 设计偏差：与"MAX_UPLOAD_SIZE 是唯一入口"不变量略有出入，但实际无害
    - 修法（可选）：让 `procRecordedVoice` 改走 `this.addFiles([file])` 而非直接调 store，恢复唯一入口

## toolCall 数据已留住，渲染 + 配对 + 增量结果待补（2026-05-03）

**背景**：本次只补齐了"数据层不阉割"——直播路径（`agent-stream.js`）和回放路径（`session-msg-group.js`）现在都把 `toolCallId` / `args`（`tool_use.input` 归一化）、toolResult 的 `toolCallId` / `isError` 透传到 step。但渲染层完全没动，下面三件事共用同一份"按 `toolCallId` 索引到原 toolCall step"的能力，登记后续一并设计落地。

47. **toolCall step 加可展开折叠区，展示 args + 完整 toolResult**
    - 现状：`ChatMsgItem.vue:130-134` 只画工具名 pill；toolResult 走另一条 step，受 `max-h-32` 限制
    - 修法：toolCall step 默认收起，点击展开看入参（pretty-printed JSON）+ 配对的 toolResult 完整内容；UX 设计时考虑 args 体积（长 bash 命令不刷屏）

48. **toolCall ↔ toolResult 按 `toolCallId` 显式配对**
    - 现状：`session-msg-group.js` 的 `processToolResult` 把 toolResult 直接 push 到 `currentTask.steps` 末尾，纯按 JSONL 出现顺序堆叠；`agent-stream.js` 直播路径同样按事件顺序排
    - 触发：现代模型并发发起多个 tool_use 块（同一 assistant message content 数组里有多个 tool_use），结果按各自跑完速度回包，顺序倒置时配对错乱
    - 修法：分组器收 toolResult 时按 `msg.toolCallId` 找对应 toolCall step 挂上去；找不到再 fallback 到末尾。直播路径同步加按 id 索引
    - 数据层已就绪（step 已带 `toolCallId`），就差查找逻辑

49. **`phase: 'update'` 流式工具增量结果接住**
    - 现状：`agent-stream.js` 没有 `phase === 'update'` 分支，partialResult 整段被吞
    - 触发：长跑工具（bash 长命令、大文件操作）会一边跑一边推 partial
    - 修法：按 `toolCallId` 找回对应 toolCall step（与 #48 共用索引），把 `partialResult` 累计到 step 上的某字段；渲染时优先显示最新 partial，result 到来后替换为终态



## AddClawPage SSE 改造遗留（2026-05-05 deep review 发现）

50. **`AddClawPage.startBinding` 无 in-flight guard，重复点击可能并发两次创建绑定码**
    - 现状：`startBinding` 没有"上一次还没结束就忽略本次"的开关；用户快速双击"重新开始"会派出两次 `createBindingCode`，后到的响应会覆盖先到的 `bindingCode`，先到的码变孤儿（仍然在服务端有效，直至自然过期）
    - 注意：本问题在改造前的轮询版本同样存在，本次 SSE 改造未引入也未放大；归类为预存
    - 修法（可选）：加 `inflight` 标志或 generation token 序列化两次调用；或简单地按钮 `disabled` 直到上次完成

51. **`AddClawPage.captureBaseline` 无超时，SSE 始终未连通时页面永久卡 "preparing"**
    - 现状：进页面后 `captureBaseline` 等 `clawsStore.fetched` 翻 true 才放行；若 SSE 永远不连通（极少：服务端可达但 SSE 路由挂掉），spinner 永远不消失
    - 现实影响低：SSE 是整个 authed 区域的命脉，SSE 死意味着 claws 列表/状态/解绑通知都不工作，用户感知到的不是"加 Claw 卡住"而是"整个 app 都不对劲"
    - 修法（可选）：加几秒超时，超时 → 走 loadError 错误态展示 retry 按钮；或者直接 fallback 到 `listClaws()` 一次拿底子

## ChatPage 触屏下拉历史 deep-review 发现的预存问题（2026-05-06）

来源：触屏下拉加载历史 + `__loadMoreHistory` race 加固 deep review。下列条目本次未修。

52. **`__loadMoreHistory` 切走再切回同一 store 实例时的 race 残留**
    - 现状：本次 race 加固用 `chatStore === targetStore` 身份比对区分"是否切走"。chatStoreManager 内同 chat 复用同实例——用户切到 B 又切回 A，A 的 store 仍是同一对象。如果旧 A 加载尚未醒来期间用户在 A 又主动下拉触发新加载，旧 A await 醒来时 race guard 不会命中，会用旧 prevScrollTop / prevHeight 测量值改 scrollTop；finally 也会因 store 一致而清掉新加载的 `__loadingHistory` 锁，可能导致后续双发
    - 触发条件极窄：切走 → 切回同 store → 期间用户主动再下拉 → 旧加载比新加载更晚醒来；本次修法前后表现一致（旧版本同样错），不是本次引入
    - 修法方向：把 store identity 比对换成 per-call token：`__loadMoreHistory` 入口 bump `__loadToken`，await 后比对 token，finally 也只在 token 匹配时清锁；可彻底覆盖"切走切回 / 同 store 多次重入"等所有路径
    - 本次只补到"切走 → 不动新视图 + 不误清新锁"层面（占绝大多数真实场景）；token 改造留待后续
