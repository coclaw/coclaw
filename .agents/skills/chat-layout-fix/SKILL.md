---
name: chat-layout-fix
description: 修复 ChatPage header/footer 不固定的布局问题。当 ChatPage header 不粘顶或 footer 不固定在底部时使用。
---

# ChatPage 布局修复

ChatPage 的核心布局是一个 **固定视口高度的 flex 列**，header 在顶部、footer（ChatInput）在底部、`<main>` 在中间滚动。

## 问题表现

- header 不粘在视口顶部
- footer（ChatInput 输入框）不固定在视口底部
- 消息多时整个页面被撑开，变成 body 级滚动

## 根因

`ChatPage.vue` 根元素 `<div>` 的 class 中出现了 `flex-1`（`flex: 1 1 0%`）。

**原理：** AuthedLayout 的 `<section>` 只有 `min-height: 100vh`，没有固定 `height`，属于**不定高度容器**。CSS Flexbox 规范规定：当 `flex-basis` 为 `0%`（非 `auto`）时，`height` 属性不作为 flex basis；在不定高度的 flex 列容器中，flex 子项的尺寸会解析为 max-content。于是 `<main>` 的 `min-h-0` 约束失效，消息内容直接撑开整条布局链。

## 修复方法

### 1. ChatPage 根元素：移除 `flex-1`

文件：`ui/src/views/ChatPage.vue`

```diff
- <div class="relative flex h-dvh flex-1 flex-col overflow-hidden">
+ <div class="relative flex h-dvh flex-col overflow-hidden">
```

### 2. 确认 `<main>` 保留 `flex-1 min-h-0`

```html
<main class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto">
```

- `flex-1`：填充 header 和 footer 之间的剩余空间
- `min-h-0`：允许 flex 子项缩小到 0（覆盖默认 `min-height: auto`），使内容在 `<main>` 内部滚动
- `overflow-x-hidden`：禁止横向滚动（CSS 规范下 overflow-y 非 visible 会使 overflow-x 也变为 auto，需显式禁止）

### 3. 关键规则总结

| 元素 | 必须有 | 禁止有 | 原因 |
|---|---|---|---|
| ChatPage 根 `<div>` | `h-dvh flex-col overflow-hidden` | `flex-1` | h-dvh 提供固定高度，flex-1 会导致不定容器中高度失控 |
| `<main>` | `flex-1 min-h-0 overflow-x-hidden overflow-y-auto` | — | flex-1 填充剩余空间，min-h-0 允许缩小，overflow-x-hidden 禁横向滚动，overflow-y-auto 内部滚动 |
| `<footer>` (ChatInput) | `sticky bottom-0` | — | 保证在 overflow 容器底部 |

## 验证

运行布局 E2E 测试：

```bash
npx playwright test e2e/chat-layout-debug.e2e.spec.js
```

测试会注入 50 条假消息，验证：
- body 不可滚动
- footer 底边 = viewport 底部
- header 顶边 = viewport 顶部
- `<main>` 内部可滚动（scrollHeight > clientHeight）
