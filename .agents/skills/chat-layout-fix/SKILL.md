---
name: chat-layout-fix
description: 修复 ChatPage header/footer 不固定的布局问题。Use when ChatPage header 不粘顶或 footer 不固定在底部。
---

# ChatPage 布局修复

ChatPage 的核心布局是一个 **固定视口高度的 flex 列**，header 在顶部、footer（ChatInput）在底部、`<main>` 在中间滚动。

## 问题表现

- header 不粘在视口顶部
- footer（ChatInput 输入框）不固定在视口底部
- 消息多时整个页面被撑开，变成 body 级滚动

## 布局架构

### AuthedLayout → ChatPage 嵌套

AuthedLayout 的 `<section>` 是 `flex min-w-0 flex-1 flex-col`，ChatPage 作为 `<router-view />` 渲染在其中。

### ChatPage 根元素：双模式动态类

文件：`ui/src/views/ChatPage.vue`

根 `<div>` 的静态 class：`relative flex flex-col overflow-hidden`
动态 `:class="chatRootClasses"`，根据运行环境切换：

```js
chatRootClasses() {
    return isCapacitorApp ? 'flex-1 min-h-0' : 'h-dvh-safe';
}
```

- **Capacitor（原生壳）**：`flex-1 min-h-0` — 填充 AuthedLayout `<section>` 的剩余 flex 空间，`min-h-0` 允许内部滚动
- **Web 浏览器**：`h-dvh-safe` — 自定义工具类（定义在 `main.css`），约束到动态视口高度，独立锚定 header 和 footer

**关键禁忌**：不能同时使用 `flex-1` 和 `h-dvh-safe`。在不定高度的 flex 列容器中，`flex-basis: 0%` 会使高度解析为 max-content，导致布局链被撑开。

### `<main>` 元素

```html
<main class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto">
```

- `flex-1`：填充 header 和 footer 之间的剩余空间
- `min-h-0`：允许 flex 子项缩小到 0（覆盖默认 `min-height: auto`），使内容在 `<main>` 内部滚动
- `overflow-x-hidden`：禁止横向滚动（CSS 规范下 overflow-y 非 visible 会使 overflow-x 也变为 auto，需显式禁止）

### ChatInput（footer）

`<ChatInput>` 作为 flex 列的最后一个子元素直接放置，**不使用** `<footer>` 标签，**不使用** `sticky` 或 `fixed` 定位。它自然位于底部，因为 `<main>` 的 `flex-1` 占满了中间空间。

## 关键规则总结

| 元素 | 必须有 | 禁止有 | 原因 |
|---|---|---|---|
| ChatPage 根 `<div>` | `flex-col overflow-hidden` + 正确的动态类 | 同时使用 `flex-1` 和 `h-dvh-safe` | 双重约束导致 max-content 撑开 |
| `<main>` | `flex-1 min-h-0 overflow-x-hidden overflow-y-auto` | — | flex-1 填充剩余空间，min-h-0 允许缩小 |
| ChatInput | 作为 flex 列最后子元素 | `sticky`/`fixed` 定位 | 依赖 flex 列布局自然定位 |

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
