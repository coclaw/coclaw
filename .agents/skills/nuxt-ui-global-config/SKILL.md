---
name: nuxt-ui-global-config
description: Globally customize Nuxt UI 4 components via the @nuxt/ui vite plugin's ui option (appConfig equivalent). Use when adding Tailwind classes (cursor-pointer, rounded-full, etc.) to all instances of a component, changing default variants, or setting compound variants — without touching each instance.
---

# Nuxt UI 4 — 全局组件配置

Nuxt UI 4 的每个组件（125+ 全部）都支持全局 Tailwind 装饰。组件用法、语义色体系、theme 结构详解归 `nuxt-ui` skill 及其 `references/theming.md`（"Component theme customization" 节）；本件只管**全局覆盖怎么写 + 本项目实测钉死的合并行为踩坑**（合并红线的单一真身在此，别处只留指针）。

## 核心机制

每个组件内部用 tailwind-variants 合成样式：`tv({ extend: tv(theme), ...appConfig.ui?.<component> })`——构建时生成的默认 theme 作 parent，用户覆盖作 child。合并是**拼接不是替换**：内置默认 class 会残留在最终 DOM 里，只靠 tailwind-merge 去重直接同属性冲突（`rounded-md` + `rounded-full` → `rounded-full`）+ CSS 优先级决胜。

## 配置入口

本项目不用 Nuxt，全局覆盖写在 `ui/vite.config.js` 的 `ui({ ui: {...} })` 插件选项里（appConfig 的 Vite 等价物）。**该文件现有配置连同注释就是案例库**——button/toaster/dropdownMenu/select/input/textarea 各块注释记录了每处覆盖的落点选择与原因，动手前先读同类先例。

覆盖片段与组件 theme 同构，四部分都可给：

```js
ui: {
	button: {
		slots: { base: 'cursor-pointer' },                     // 追加 slot class（最常用）
		variants: { size: { md: { leadingIcon: 'size-4' } } }, // 覆盖 variant 样式
		compoundVariants: [{ color: 'neutral', variant: 'outline', class: { base: 'ring-2' } }],
		defaultVariants: { variant: 'outline' },               // 修改默认 prop
	},
}
```

## 查看组件 theme

覆盖前**必须**先看目标组件的生成 theme：`ui/node_modules/.nuxt-ui/ui/<component>.ts`（Vite 构建时生成）。每个组件 slot 名不同；内置 class 落在 slots 还是 variants，决定你的覆盖该落哪（见下方红线第 3 条）。内置主题的打包产物在 `@nuxt/ui/dist/shared/ui.<hash>.mjs`——文件名带哈希，别在测试里 import 它。

## 覆盖优先级

`ui` prop / `class` prop > 全局配置 > theme 默认值。全局配置会被实例级 `:ui` / `class` 覆盖。

## 合并行为红线（真实 DOM 实测钉死，别按直觉推）

- **简写残留**：tailwind-merge 只去重直接同属性冲突；内置的简写（`p-4`、`sm:p-6`）不会被你的 `pb-5` 删掉。**凡内置在某断点用了简写，同断点要显式盖对应方向**（如 `pb-5 sm:pb-5`——少写 `sm:` 那份，桌面端就被残留的 `sm:p-6` 顶回）。
- **variant 覆盖里别带想保留的内置 slot 键**：对象深合并的字符串叶子是"覆盖方先赢"，在 `variants.xxx.yyy` 里写了 `content` 就把内置 `content` 整个顶掉（modal 全屏曾因此画错）。只写要改的键。
- **内置落在 variant 上的属性，覆盖顶层 `slots.base` 会被变体类去重吃掉**（tv 实测；如 input 各 size 的字号/文字色）——覆盖须落在同名 variant 的 base 上（`variants.size.<每档>.base`，每档都写）。与末条的分工：改**静态逐档**样式落这里；要盖内置**响应式断点**规则（带 `md:` 等前缀的）走 compoundVariants（见末条）。
- **tailwind-merge 不认 Nuxt UI 语义色为同组**：`text-default` 压不掉内置 `text-highlighted`，两者并存只能 `text-default!` important 决胜。
- **`input` 覆盖不传导到 `textarea`**：theme 由 input 工厂派生，但配置按组件名取——两者要分别写。
- **compoundVariants 合并是 append**：你的排在内置之后，同断点同属性靠 tailwind-merge 后者胜出——这是盖内置响应式规则的正解（如 input 用 compoundVariants 的 `md:text-base` 盖回内置 `md:text-sm`；写进 base 无效，compound 在 base 之后应用会反盖）。背景：input 内置的响应式字号（手机 16px、md+ 缩 14/12px）是 iOS 防聚焦缩放方案，但它按宽度 ≥768 当"桌面"，漏掉横屏 iPhone/iPad——仍是 iOS Safari，<16px 照样触发聚焦缩放，故本项目全档盖回 16px。另：`defaultVariants` 翻到 theme 里没定义的分支值是空操作（如 input 的 `fixed` 只定义了 `false` 分支，翻成 `true` 看着改了实际没动）。

## 测试限制

`ui/vitest.config.js` 不挂 `@nuxt/ui/vite` 插件，全局主题在单测里**惰性**（弹窗测试普遍 stub UModal）。全局主题只做"配置对象形态"级单测（见 `ui/src/constants/modal-theme.js` 及其测试），合并后的真实渲染靠 dev + devtools/截图验证。已评估过补真实渲染测试（复刻合并/改测试基建/E2E），不划算、不补。

## 常见全局装饰模式

| 需求 | 配置 |
|------|------|
| 所有按钮手指光标（Tailwind v4 preflight 不再给 `<button>` 设 cursor，Nuxt UI 也不内置） | `button.slots.base: 'cursor-pointer'` |
| 所有按钮点击反馈 | `button.slots.base: 'active:scale-[0.98] active:opacity-80'` |
| 所有卡片圆角加大 | `card.slots.root: 'rounded-2xl'` |
| 所有 Badge 改药丸形 | `badge.slots.base: 'rounded-full'` |
