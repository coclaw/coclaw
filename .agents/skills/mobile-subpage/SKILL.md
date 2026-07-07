---
name: mobile-subpage
description: 移动端子页面适配规范（MobilePageHeader + 路由 meta）。Use when 新建非底部导航直达的子页面，或调整移动端页面 header/导航栏显隐。
---

# 移动端子页面适配

新建子页面（非底部导航直达页）时，遵循以下规范。

## MobilePageHeader 组件

位于 `ui/src/components/MobilePageHeader.vue`，仅移动端可见（`md:hidden`），根元素带 `data-testid="mobile-page-header"`（E2E 锚点）。

```vue
<MobilePageHeader :title="$t('xxx.title')">
	<template #actions>
		<!-- 可选：右侧操作按钮 -->
	</template>
</MobilePageHeader>
```

Props:
- `title` (String) — 页面标题
- `fallback` (String，默认 `'/'`) — 无浏览历史时返回按钮的跳转目标

Slot:
- 默认 slot — 自定义标题内容，替代 `title` prop（如 ChatPage 的双段标题）
- `actions` — 右侧操作按钮区域（可选）

返回逻辑：走 `src/utils/nav-back.js` 的 `navBack(router, fallback)`——有上一页则 `router.back()`，否则 `router.replace(fallback)`（覆盖 Electron/Capacitor 冷启动直进 deep link、history 栈为空的边界）。

## 路由 meta 约定

| meta 字段 | 含义 | 示例页面 |
|---|---|---|
| `isTopPage: true` | 底部导航直达页，不显示返回按钮 | topics、claws、user |
| `hideMobileNav: true` | 隐藏底部导航栏 | chat、claws-add、about |

子页面通常设置 `hideMobileNav: true`，不设置 `isTopPage`。

## 新建子页面 Checklist

1. 在 `router/index.js` 添加路由，设置 `meta: { hideMobileNav: true }`
2. 页面模板顶部添加 `<MobilePageHeader :title="..." />`
3. 桌面端标题行使用 `hidden md:flex` 仅桌面端可见
4. 在 `<script>` 中显式导入并注册组件——构建期虽有组件自动注册（components.d.ts），但 vitest 不挂 `@nuxt/ui/vite` 插件、自动注册在单测里不生效，显式 import 才可测：
   ```js
   import MobilePageHeader from '../components/MobilePageHeader.vue';
   // components: { MobilePageHeader }
   ```
5. 编写/更新对应测试（E2E 断言用 data-testid，不用文案）
6. 若顺带新增了 `src/components/` 下的组件：`ui/components.d.ts` 只在 dev/build 时再生（vitest/check 不刷它），收尾跑一次 dev 或 build，把更新后的 `components.d.ts` 随改动一起提交

## Safe area

贴状态栏/底部手势区的元素不要裸用 `env(safe-area-inset-*)`——Android 14 及以下它恒为 0（Capacitor 仅 Android 15+ 注入）。统一用 `main.css` 全局定义的 `var(--safe-area-inset-top/bottom)` 变量（默认取 env()），注意两者兜底不对称：

- **top**：原生壳启动期用 StatusBar 实测高度覆盖该变量（`ui/src/utils/capacitor-app.js`），可直接信赖
- **bottom**：无 JS 注入兜底，贴底元素常配 `max(<地板值>, var(--safe-area-inset-bottom))` 保底（现成用法见 `ui/src/constants/modal-theme.js`；地板值按场景定）
