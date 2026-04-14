---
"@coclaw/ui": patch
---

refactor(ui): 统一进度指示为通用 ProgressRing 圆形组件

- 新增 `src/components/ProgressRing.vue`:精确还原 Quasar `q-circular-progress` 几何公式(viewBox = 100/(1−thickness/2), radius = 50, strokeWidth = thickness/2 × viewBox);双模式(value 0~1 确定态 / null 不定态);Nuxt UI 语义色 + ARIA 1.2 属性
- `ChatInput`:移除手写 SVG 进度圈,改用 `<ProgressRing>`;`__filePercent` → `__fileProgress`(直接传 0~1);轨道由 `stroke-muted/30` 升级为 `stroke-muted` 不透明,解决原"残缺感"
- `FileUploadItem` / `FileListItem`:条形进度 → 圆形,与 action 按钮并列,对移动端更友好;FileListItem 下载新增中央百分比显示
- 配套 32 个 ProgressRing 单元测试 + 联动测试断言更新
- 后续改进项(a11y i18n、窄屏验证、测试增强等)登记于 `ui/TODO.md`
