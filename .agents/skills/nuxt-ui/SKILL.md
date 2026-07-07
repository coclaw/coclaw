---
name: nuxt-ui
description: Build UIs with @nuxt/ui v4 — 125+ accessible Vue components with Tailwind CSS theming. Use when creating interfaces, customizing themes to match a brand, building forms, or composing layouts like dashboards, docs sites, and chat interfaces.
---

# Nuxt UI

Vue component library built on [Reka UI](https://reka-ui.com/) + [Tailwind CSS](https://tailwindcss.com/) + [Tailwind Variants](https://www.tailwind-variants.org/). Works with Nuxt and plain Vue (Vite).

> 维护约定：`references/` 是 vendored 上游参考（口径 @nuxt/ui v4）——上游事实有误才改英文正文，项目差异只写进下方对齐节与 "> CoClaw：" 插注（grep 该前缀可整体检视/重放）；本 SKILL.md 是项目化入口，可自由重组。@nuxt/ui 升大版本时以新上游文本为底、机械重放对齐节与插注，版本敏感行为以 `ui/package.json` 与安装版为准重核。

## CoClaw 项目对齐（动手前先读）

- **本仓不用 Nuxt 框架**：Vue 3 + Vite + Vue Router + Pinia。示例里的 Nuxt 专属物（`app.config.ts`、`NuxtPage`/`NuxtLayout`、`definePageMeta`、`useAsyncData`、`@nuxt/content`）本仓都没有——成对示例一律取 "Vue —" 变体；layout 参考取组件组合结构，路由/取数自行换写。
- **代码风格**：JS + Options API，不用 `<script setup>`/TS（见 `ui/AGENTS.md`）——上游示例照抄前先转换。
- **接线已就绪，勿重装**：`ui/vite.config.js` 挂 `ui()` 插件；`ui/src/main.js` `app.use(ui)`（`@nuxt/ui/vue-plugin`）；`ui/src/assets/main.css` 已引 tailwindcss + @nuxt/ui；`App.vue` 已包 `<UApp>`。
- **全局主题/组件覆盖**：入口是 `ui/vite.config.js` 里 `ui()` 的 `ui:` 选项（无 app.config 文件）。合并是**拼接不是替换**、内置默认 class 会残留——全套实测合并红线（简写残留、variant 字符串叶子替换、`defaultVariants` 空操作、`compoundVariants` 追加取胜等）单点维护在 `nuxt-ui-global-config` skill，动全局覆盖前先读。
- **查组件 slot 名/默认 class 的权威**：`ui/node_modules/.nuxt-ui/ui/<component>.ts`（构建时生成）。
- **dvh 基线缺口**：基线浏览器（`build.target`：Chrome/Edge 90、Safari 15、Firefox 90）不支持 `dvh`，而默认 modal 主题用 `max-h-[calc(100dvh-…)]` 封顶 → 基线上桌面 modal 失去视口封顶，超高内容被裁切且滚不动。修法：给 modal 内的高内容容器加 **vh** 上限（如 `md:max-h-[calc(100vh-Nrem)]`，N ≈ 面板边距 + header + padding 总和，低于该地板会让 body 溢出冒滚动条）。移动端全屏 modal（`content: 'inset-0'`）不受影响。dvh 全局政策（必须 fallback、`.h-dvh-safe`）见 `ui/AGENTS.md`。
- **操作反馈别直接 `useToast()`**：本仓统一走全局 `useNotify()`（何时 notify、测试 mock 见 `ui-notify` skill）；store 里不 import nuxt-ui。
- **confirm / 单行输入弹窗**：有现成封装（UModal + `promptModalUi`），见 `prompt-confirm-dialog` skill，别重复搭。
- **vitest 不挂 `@nuxt/ui` 插件**：单测里无 U* 自动导入、全局主题不生效——组件测试显式 import 或 stub（UModal 普遍被 stub）；全局主题只能做「配置对象形态」级单测。

## Setup (Vue + Vite)

Already wired in this repo — kept as compact reference:

```ts
// vite.config — this repo: ui/vite.config.js
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

export default defineConfig({
  plugins: [vue(), ui({ ui: { colors: { primary: 'indigo' } } })]
})
```

```ts
// main entry — this repo: ui/src/main.js
import ui from '@nuxt/ui/vue-plugin'

app.use(router)
app.use(ui)
```

```css
/* main.css */
@import "tailwindcss";
@import "@nuxt/ui";
```

- **`UApp` is required** at the root — it provides global config for toasts, tooltips, and programmatic overlays, and accepts a `locale` prop for i18n (see [composables reference](references/composables.md)).
- Plain Vue: add `class="isolate"` to the root `<div id="app">` in `index.html`.
- Nuxt / Laravel (Inertia) / AdonisJS setup: see upstream docs — not used in this repo.

## Icons

Nuxt UI uses [Iconify](https://iconify.design/) — icons follow `i-{collection}-{name}` and work out of the box via the Vite plugin:

```vue
<UIcon name="i-lucide-sun" class="size-5" />
<UButton icon="i-lucide-plus" label="Add" />
<UAlert icon="i-lucide-info" title="Heads up" />
```

Browse icons at [icones.js.org](https://icones.js.org); the `lucide` collection is used throughout Nuxt UI defaults. Install collections locally: `pnpm i @iconify-json/lucide`.

## Theming & Branding

**Always use semantic utilities** (`text-default`, `bg-elevated`, `border-muted`), never raw Tailwind palette colors. See [references/theming.md](references/theming.md) for the full list.

### Colors

7 semantic colors (`primary`, `secondary`, `success`, `info`, `warning`, `error`, `neutral`) configurable at runtime:

```ts
// Vue — vite.config (this repo: ui/vite.config.js maps them to the custom cc-* palette)
ui({
  ui: { colors: { primary: 'indigo', neutral: 'zinc' } }
})
```

(Nuxt projects put the same `ui: {...}` object in `app.config.ts` via `defineAppConfig`.)

### Customizing components

**Override priority** (highest wins): `ui` prop / `class` prop > global config > theme defaults.

The `ui` prop overrides a component's **slots** after variants are computed:

```vue
<UButton :ui="{ base: 'rounded-none', trailingIcon: 'size-3 rotate-90' }" />
<UCard :ui="{ header: 'bg-muted', body: 'p-8' }" />
```

**Read the generated theme file** to find slot names for any component: `node_modules/.nuxt-ui/ui/<component>.ts` (Vue) / `.nuxt/ui/<component>.ts` (Nuxt).

> Merge semantics（defaults concatenate and survive — 全套实测红线）: `nuxt-ui-global-config` skill. CSS variables, custom colors, theme structure, and the brand playbook: [references/theming.md](references/theming.md)

## Composables

```ts
// Notifications (CoClaw: use the project-global `useNotify()` instead — see alignment notes above)
const toast = useToast()
toast.add({ title: 'Saved', color: 'success', icon: 'i-lucide-check' })

// Programmatic overlays
const overlay = useOverlay()
const modal = overlay.create(MyModal)
const { result } = modal.open({ title: 'Confirm' })
await result

// Keyboard shortcuts
defineShortcuts({
  meta_k: () => openSearch(),
  escape: () => close()
})
```

> Full reference: [references/composables.md](references/composables.md)

## Form validation

Uses Standard Schema — works with Zod, Valibot, Yup, or Joi (this repo bundles none yet; adding one is a dependency decision).

```vue
<UForm :schema="schema" :state="state" @submit="onSubmit">
  <UFormField name="email" label="Email" required>
    <UInput v-model="state.email" type="email" />
  </UFormField>
  <UButton type="submit">Sign in</UButton>
</UForm>
```

`UForm` validates before emitting `@submit` — state is valid inside the handler. Full patterns (Zod/Valibot examples, file upload): [references/components.md](references/components.md#form)

## Overlays

```vue
<!-- Modal -->
<UModal v-model:open="isOpen" title="Edit" description="Edit your profile">
  <template #body>Content</template>
  <template #footer>
    <UButton variant="ghost" @click="isOpen = false">Cancel</UButton>
    <UButton @click="save">Save</UButton>
  </template>
</UModal>

<!-- Slideover (side panel) -->
<USlideover v-model:open="isOpen" title="Settings" side="right">
  <template #body>Content</template>
</USlideover>

<!-- Dropdown menu (nested array = groups with automatic separators) -->
<UDropdownMenu :items="[
  [{ label: 'Edit', icon: 'i-lucide-pencil' }, { label: 'Duplicate', icon: 'i-lucide-copy' }],
  [{ label: 'Delete', icon: 'i-lucide-trash', color: 'error' }]
]">
  <UButton icon="i-lucide-ellipsis-vertical" variant="ghost" />
</UDropdownMenu>
```

Modal gotchas (conditional `#footer`, `dvh` height cap) and all overlay components: [references/components.md](references/components.md#overlay)

## Layouts

Nuxt UI provides components to compose full page layouts. Load the reference matching your use case:

| Layout | Description | Reference |
|---|---|---|
| Page | Landing, blog, changelog, pricing — public-facing pages | [layouts/page.md](references/layouts/page.md) |
| Dashboard | Admin UI with resizable sidebar and panels | [layouts/dashboard.md](references/layouts/dashboard.md) |
| Docs | Documentation with sidebar nav and TOC | [layouts/docs.md](references/layouts/docs.md) |
| Chat | AI chat with messages and prompt | [layouts/chat.md](references/layouts/chat.md) |
| Editor | Rich text editor with toolbars | [layouts/editor.md](references/layouts/editor.md) |

> Layout 参考全部是上游 Nuxt 语境（`NuxtLayout`/`definePageMeta`/`@nuxt/content`/Vercel AI SDK）——取组件组合结构，脚手架按上文对齐节换写。CoClaw 聊天走 OpenClaw 通道、**不用 Vercel AI SDK**；docs/editor 布局本仓当前未用。

## Templates

Official starter templates (Nuxt & Vue: starter, dashboard, SaaS, docs, chat, editor, …): [github.com/nuxt-ui-templates](https://github.com/nuxt-ui-templates) — for greenfield projects, not this repo.

## Additional references

Load based on your task — **do not load all at once**:

- [references/theming.md](references/theming.md) — CSS variables, custom colors, component theme overrides
- [references/components.md](references/components.md) — all 125+ components by category with props and usage
- [references/composables.md](references/composables.md) — useToast, useOverlay, defineShortcuts
- Generated theme files — all slots, variants, and default classes: `ui/node_modules/.nuxt-ui/ui/<component>.ts`
