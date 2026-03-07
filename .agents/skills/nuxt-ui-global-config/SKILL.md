---
name: nuxt-ui-global-config
description: Globally customize Nuxt UI 4 components via appConfig. Use when adding Tailwind classes (cursor-pointer, rounded-full, etc.) to all instances of a component, changing default variants, or setting compound variants — without touching each instance.
---

# Nuxt UI 4 — 全局组件配置

Nuxt UI 4 的每个组件都支持通过 `appConfig.ui.<component>` 进行全局 Tailwind 装饰。这是选用 Nuxt UI 的核心优势之一。

## 核心机制

每个组件内部：

```js
import theme from "#build/ui/button";       // 构建时生成的默认 theme
const appConfig = useAppConfig();            // 全局配置（来自 vite.config 或 app.config）

const ui = computed(() => tv({
  extend: tv(theme),                         // 默认 theme 作为 parent
  ...appConfig.ui?.button || {}              // 用户覆盖作为 child
})({ color, variant, size, ... }));
```

关键行为：**tailwind-variants 的 `extend` 会将 child 的 class 追加合并到 parent，而非替换。** tailwind-merge 自动解决冲突（如 `rounded-md` + `rounded-full` → `rounded-full`）。

## 配置入口

### Vue (Vite) — 本项目使用此方式

```js
// vite.config.js
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

### Nuxt

```js
// app.config.ts
export default defineAppConfig({
  ui: {
    button: {
      slots: { base: 'cursor-pointer' },
    },
  },
});
```

## Theme 结构

每个组件的 theme 由 tailwind-variants 定义，包含以下部分：

```js
{
  slots: {             // 组件的样式插槽，每个插槽对应一个 DOM 元素
    base: '...',       // 根/主元素
    label: '...',
    leadingIcon: '...',
    // ...
  },
  variants: {          // 根据 props 条件应用不同样式
    color: { primary: '...', neutral: '...' },
    variant: { solid: '...', ghost: '...', link: '...' },
    size: { xs: { base: '...', leadingIcon: '...' }, md: { ... } },
  },
  compoundVariants: [  // 多个 variant 组合时的样式
    { color: 'primary', variant: 'outline', class: { base: '...' } },
  ],
  defaultVariants: {   // 未指定 prop 时的默认值
    color: 'primary',
    variant: 'solid',
    size: 'md',
  },
}
```

### 查看组件的完整 theme

生成的 theme 文件包含所有 slots、variants 和默认 class：

- **Vue (Vite)**：`node_modules/.nuxt-ui/ui/<component>.ts`
- **Nuxt**：`.nuxt/ui/<component>.ts`

**在进行全局覆盖前，务必先查看目标组件的 theme 文件确认 slot 名称。**

## 覆盖优先级

**`ui` prop / `class` prop > 全局 appConfig > theme 默认值**

即：全局配置会被实例级 `:ui` prop 或 `class` 覆盖。

## 全局覆盖能力

### 1. 追加 slot class（最常用）

为所有实例的某个 slot 追加 Tailwind class：

```js
ui: {
  button: {
    slots: {
      base: 'cursor-pointer active:scale-[0.98] active:opacity-80',
    },
  },
  card: {
    slots: {
      root: 'shadow-lg rounded-2xl',
    },
  },
  avatar: {
    slots: {
      root: 'ring-2 ring-primary',
    },
  },
}
```

### 2. 覆盖 variant 样式

修改特定 variant 的表现：

```js
ui: {
  button: {
    variants: {
      size: {
        md: { leadingIcon: 'size-4' },
      },
    },
  },
}
```

### 3. 添加 compound variants

为特定 prop 组合添加样式：

```js
ui: {
  button: {
    compoundVariants: [
      { color: 'neutral', variant: 'outline', class: { base: 'ring-2' } },
    ],
  },
}
```

### 4. 修改 default variants

改变未指定 prop 时的默认行为：

```js
ui: {
  button: {
    defaultVariants: {
      color: 'neutral',
      variant: 'outline',
    },
  },
}
```

## 常见全局装饰模式

| 需求 | 配置 |
|------|------|
| 所有按钮显示手指光标 | `button.slots.base: 'cursor-pointer'` |
| 所有按钮点击反馈 | `button.slots.base: 'active:scale-[0.98] active:opacity-80'` |
| 所有卡片圆角加大 | `card.slots.root: 'rounded-2xl'` |
| 所有按钮默认用 outline 风格 | `button.defaultVariants: { variant: 'outline' }` |
| 所有 Badge 改为药丸形 | `badge.slots.base: 'rounded-full'` |

## 注意事项

- class 是**追加合并**，不是替换。冲突的 class 由 tailwind-merge 自动解决
- 每个组件的 slot 名称不同，覆盖前先查看 theme 文件
- 所有 125+ 组件均支持此机制（内部统一使用 `tv({ extend: tv(theme), ...appConfig.ui?.<component> })` 模式）
- Tailwind v4 preflight 不再为 `<button>` 设置 `cursor: pointer`，Nuxt UI 也不内置，需全局配置补齐
