---
name: mobile-subpage
description: 移动端子页面适配规范。新建子页面时使用 MobilePageHeader 组件、设置路由 meta（isTopPage / hideMobileNav），遵循 checklist。
---

# 移动端子页面适配

新建子页面（非底部导航直达页）时，遵循以下规范。

## MobilePageHeader 组件

位于 `ui/src/components/MobilePageHeader.vue`，仅移动端可见（`md:hidden`）。

```vue
<MobilePageHeader :title="$t('xxx.title')">
  <template #actions>
    <!-- 可选：右侧操作按钮 -->
  </template>
</MobilePageHeader>
```

Props:
- `title` (String) — 页面标题

Slot:
- `actions` — 右侧操作按钮区域（可选）

返回逻辑：有浏览历史时 `router.back()`，否则 `router.replace('/')`。

## 路由 meta 约定

| meta 字段 | 含义 | 示例页面 |
|---|---|---|
| `isTopPage: true` | 底部导航直达页，不显示返回按钮 | topics、bots、user |
| `hideMobileNav: true` | 隐藏底部导航栏 | chat、bots-add、about |

子页面通常设置 `hideMobileNav: true`，不设置 `isTopPage`。

## 新建子页面 Checklist

1. 在 `router/index.js` 添加路由，设置 `meta: { hideMobileNav: true }`
2. 页面模板顶部添加 `<MobilePageHeader :title="..." />`
3. 桌面端标题行使用 `hidden md:flex` 仅桌面端可见
4. 在 `<script>` 中导入并注册组件：
   ```js
   import MobilePageHeader from '../components/MobilePageHeader.vue';
   // components: { MobilePageHeader }
   ```
5. 编写/更新对应测试
