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
