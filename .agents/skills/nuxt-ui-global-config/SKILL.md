---
name: nuxt-ui-global-config
description: Globally customize Nuxt UI 4 components via appConfig. Use when adding Tailwind classes (cursor-pointer, rounded-full, etc.) to all instances of a component, changing default variants, or setting compound variants — without touching each instance.
---

# Nuxt UI 4 — 全局组件配置

Nuxt UI 4 的每个组件都支持通过 `appConfig.ui.<component>` 进行全局 Tailwind 装饰。这是选用 Nuxt UI 的核心优势之一。

## 核心机制

每个组件内部用 tailwind-variants 合成样式：`tv({ extend: tv(theme), ...appConfig.ui?.<component> })`——构建时生成的默认 theme 作 parent，用户覆盖作 child。

关键行为：**`extend` 会将 child 的 class 追加合并到 parent，而非替换。** 冲突 class 由 tailwind-merge 自动解决（如 `rounded-md` + `rounded-full` → `rounded-full`）。

## 配置入口 — 本项目用 Vue (Vite) 方式

```js
// ui/vite.config.js
import ui from '@nuxt/ui/vite';

export default defineConfig({
  plugins: [
    vue(),
    ui({
      ui: {
        // 全局组件覆盖写在这里
        button: {
          slots: { base: 'cursor-pointer' },
        },
      },
    }),
  ],
});
```

（Nuxt 项目则写在 `app.config.ts` 的 `defineAppConfig({ ui: {...} })`，本项目不用。）

## Theme 结构与查看

每个组件的 theme 由 tailwind-variants 定义，含四部分：`slots`（样式插槽，对应 DOM 元素）、`variants`（按 props 条件样式）、`compoundVariants`（prop 组合样式）、`defaultVariants`（未指定 prop 时的默认值）。全局覆盖就是按同结构提供片段。结构详解与更多示例见 `.agents/skills/nuxt-ui/references/theming.md` 的 "Component theme customization" 节。

查看组件完整 theme（所有 slot 名、variants、默认 class）：`node_modules/.nuxt-ui/ui/<component>.ts`（Vite 构建时生成）。

**在进行全局覆盖前，务必先查看目标组件的 theme 文件确认 slot 名称。**

## 覆盖优先级

**`ui` prop / `class` prop > 全局 appConfig > theme 默认值**

即：全局配置会被实例级 `:ui` prop 或 `class` 覆盖。

## 覆盖示例

四类能力按 theme 同构片段写即可：

```js
ui: {
  button: {
    slots: { base: 'cursor-pointer active:scale-[0.98]' },  // 1. 追加 slot class（最常用）
    variants: {
      size: { md: { leadingIcon: 'size-4' } },              // 2. 覆盖 variant 样式
    },
    compoundVariants: [                                     // 3. 添加 compound variants
      { color: 'neutral', variant: 'outline', class: { base: 'ring-2' } },
    ],
    defaultVariants: { variant: 'outline' },                // 4. 修改默认 prop
  },
}
```

## 常见全局装饰模式

| 需求 | 配置 |
|------|------|
| 所有按钮显示手指光标 | `button.slots.base: 'cursor-pointer'` |
| 所有按钮点击反馈 | `button.slots.base: 'active:scale-[0.98] active:opacity-80'` |
| 所有卡片圆角加大 | `card.slots.root: 'rounded-2xl'` |
| 所有 Badge 改为药丸形 | `badge.slots.base: 'rounded-full'` |

## 注意事项

- class 是**追加合并**，不是替换；冲突由 tailwind-merge 自动解决
- 每个组件的 slot 名称不同，覆盖前先查看 theme 文件
- 所有 125+ 组件均支持此机制
- Tailwind v4 preflight 不再为 `<button>` 设置 `cursor: pointer`，Nuxt UI 也不内置，需全局配置补齐
