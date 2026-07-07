---
name: chat-layout-fix
description: 修复 ChatPage header/footer 不固定的布局问题。Use when ChatPage header 不粘顶或 footer 不固定在底部。
---

# ChatPage 布局修复

ChatPage（`ui/src/views/ChatPage.vue`）的核心布局是**固定视口高度的 flex 列**：header 在顶部、footer（ChatInput）在底部、`<main>` 在中间滚动。一手约束注释在该文件模板头部，改布局前先读。

## 问题表现

- header 不粘视口顶部 / footer（ChatInput 输入框）不固定视口底部
- 消息多时整页被撑开，变成 body 级滚动

## 关键规则

根元素动态类双模式（`chatRootClasses` computed）：Capacitor 原生壳用 `flex-1 min-h-0`（填充 AuthedLayout 的剩余 flex 空间）；Web 浏览器用 `h-dvh-safe`（`main.css` 自定义工具类，dvh + `@supports` 回退 vh）。Web 侧此约束是临时方案，全面改为浏览器滚动后可移除——届时本表随之作废。

| 元素 | 必须有 | 禁止有 | 原因 |
|---|---|---|---|
| ChatPage 根 `<div>` | `flex-col overflow-hidden` + 正确的动态类 | 同时 `flex-1` 和 `h-dvh-safe` | 不定高度 flex 列中 `flex-basis: 0%` 会使高度解析为 max-content，布局链被撑开 |
| `<main>` | `flex-1 min-h-0 overflow-x-hidden overflow-y-auto` | — | flex-1 填充剩余空间；min-h-0 覆盖默认 `min-height: auto`，使内容在 `<main>` 内滚动；overflow-y 非 visible 时 overflow-x 会退化为 auto，需显式 hidden 禁横向滚动 |
| ChatInput | 作为 flex 列最后子元素 | `sticky`/`fixed` 定位 | 依赖 flex 列自然定位 |

## 验证

布局回归由 E2E 钉死（按项目政策，用户明确要求时才执行）：

```bash
npx playwright test e2e/chat-layout-debug.e2e.spec.js
```

注入大量假消息，断言：body 不可滚动、chat root 高度不超 viewport、footer 底边 = viewport 底部、header 顶边 = viewport 顶部、`<main>` 内部可滚动（scrollHeight > clientHeight）。
