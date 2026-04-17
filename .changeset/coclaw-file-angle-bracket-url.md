---
'@coclaw/ui': patch
---

修复文件名含半角括号时 `coclaw-file:` 链接被截断导致下载失败的 bug。

原因：`preprocessCoclawFileLinks` 与 `extractCoclawFileRefs` 的正则用 `[^)]+` 截取 URL，碰到文件名里的 `)` 就提前收尾，下载请求带着被截断的路径自然失败。

修复：

- Agent 提示词改为 `[文件名](<coclaw-file:文件路径>)` 形式（CommonMark 尖括号包裹），并明确声明"URL 必须用尖括号 < > 包裹"的硬约束
- 两处正则统一合并为 `coclaw-file.js` 的 `findCoclawMarkdownLinks` 工具函数，同时兼容尖括号形式与裸形式
- 裸形式若出现半角括号直接不匹配（宁可渲染为原文也不生成截断的错误链接）
- 尖括号分支同时排除 `\r` 和 `\n`，避免 CR 字符注入 URL
