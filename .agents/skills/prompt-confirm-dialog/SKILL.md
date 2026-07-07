---
name: prompt-confirm-dialog
description: 创建 prompt（单行输入）和 confirm（确认操作）对话框，基于 UModal + promptModalUi 共享样式。Use when 需要创建确认对话框、单行输入对话框、或类似轻量交互弹窗。
---

# Prompt / Confirm 对话框

CoClaw UI 中 prompt（单行文本输入）和 confirm（确认操作）对话框统一使用 `UModal` + 共享 `:ui` 覆盖。

## 共享样式常量

```js
import { promptModalUi } from '../constants/prompt-modal-ui.js';
```

通过 `setup()` 暴露给模板：

```js
setup() {
	return { promptUi: promptModalUi };
},
```

常量的具体值与设计意图见源文件 `ui/src/constants/prompt-modal-ui.js`（JSDoc 注释即文档）：缩窄宽度、去分割线、header 留呼吸感，仅作用于套用本覆盖的轻量弹窗。现有用法定点搜 `rg promptModalUi ui/src` 即得。

## Confirm 对话框模板

用于破坏性操作（删除等）的二次确认。

```vue
<UModal v-model:open="deleteOpen" :title="$t('xxx.confirmTitle')" description=" " :ui="promptUi">
	<template #body>
		<p class="text-sm text-muted">{{ $t('xxx.confirmDesc') }}</p>
	</template>
	<template #footer>
		<div class="flex w-full justify-end gap-2">
			<UButton variant="ghost" color="neutral" @click="deleteOpen = false">{{ $t('common.cancel') }}</UButton>
			<UButton color="error" :loading="deleting" @click="onConfirmDelete">{{ $t('common.confirm') }}</UButton>
		</div>
	</template>
</UModal>
```

要点：
- 标题通过 `:title` prop 放在 header（默认左对齐）
- **恒传 `description=" "`**（现役用法零例外）：压掉底层（Reka UI Dialog）缺失 description 的控制台警告
- 可见描述文案一律放 `#body`，**不要**用 `:description` prop 承载（会挤在 header 中）

## Prompt 对话框模板

用于单行文本输入（重命名、编辑等）。

```vue
<UModal v-model:open="editOpen" :title="$t('xxx.editTitle')" description=" " :ui="promptUi">
	<template #body>
		<UInput
			v-model="editValue"
			autofocus
			class="w-full"
			:placeholder="$t('xxx.placeholder')"
			@keydown.enter="onConfirmEdit"
		/>
	</template>
	<template #footer>
		<div class="flex w-full justify-end gap-2">
			<UButton variant="ghost" color="neutral" @click="editOpen = false">{{ $t('common.cancel') }}</UButton>
			<UButton :disabled="!editValue.trim()" :loading="saving" @click="onConfirmEdit">{{ $t('common.confirm') }}</UButton>
		</div>
	</template>
</UModal>
```

要点：
- `UInput` 必须加 `class="w-full"` 撑满宽度
- `autofocus` 自动获焦；`@keydown.enter` 支持回车确认
- 确认按钮在输入为空时 `:disabled`

## Footer 按钮规范（两类模板通用）

- 按钮区域使用 `<div class="flex w-full justify-end gap-2">` 包裹，右对齐
- 取消按钮：`variant="ghost" color="neutral"`
- 确认按钮：默认 primary 色，破坏性操作用 `color="error"`
- 支持 `:loading` 状态防止重复提交
- 需要 E2E 断言的按钮加 `data-testid`（本项目 E2E 用 testid 锚点，不用文案）

## 条件性 footer 的坑

UModal 的 footer 壳子按 `!!slots.footer` 渲染——**只要提供了 `#footer` slot，哪怕内部 v-if 全为假，带 padding 的空壳也会渲染成一条空白带**。多步/多模式弹窗要条件性显示 footer 时，把 v-if 放在 slot 模板本身上：`<template v-if="cond" #footer>`（Vue 会过滤 falsy 槽项，壳子才不渲染；现成范例见 `AddProviderDialog` 的分步 footer）。
