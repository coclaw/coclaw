# UI TODO

非阻塞改进点登记。每条记录"问题 / 修复方向 / 关联 commit"。

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

16. **silent loadMessages 连续失败时"思考中"遮罩永久挂着（预存，非本次引入）**
    - 现状：`__awaitPersistAndDrop` 在 `ok=false` 时直接 return，不调 `dropRun`。设计上想靠 24h timer / `activate` / `__onConnReady` 兜底，但都不成立——`__endRun` 触发时 24h timer 已被清掉（`agent-runs.store.js:338-341`）；`activate` 和 `__onConnReady` 的 silent reload 直接调 `loadMessages`，不走 `__awaitPersistAndDrop`，所以永远不会再 `dropRun`。结果：网络抖一下 → 那条消息的"思考中"会一直挂着，直到刷新页面或换 claw。`chat.store.js` 旧代码也是同样行为，本次只是把错的注释沿用过来
    - 触发条件较窄：必须 lifecycle/wait/failed 等事件已收到（说明 DC 通的），紧接着发的 silent reload 又恰好失败两次
    - 修复方向（codex 给的两个方案）：
        - 方案 A：在 `ok=false` 分支挂一个 30s 重试 timer，retry 成功走正常 drop，retry 仍失败再打 remoteLog + 强制 drop
        - 方案 B：在 `activate` / `__onConnReady` 的 silent reload 成功后补一个 `dropEndedRunIfTerminal(runKey, runId)` reconcile 路径
    - 必须配套补单元测试

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
