---
name: prompt-confirm-dialog
description: 创建 prompt（单行输入）和 confirm（确认操作）对话框。使用 UModal + promptModalUi 共享样式，遵循移动端优先原则。当需要创建确认对话框、单行输入对话框、或类似轻量交互弹窗时使用。
---

# Prompt / Confirm 对话框

CoClaw UI 中 prompt（单行文本输入）和 confirm（确认操作）对话框统一使用 `UModal` + 共享 `:ui` 覆盖。

## 共享样式常量

```js
// ui/src/constants/prompt-modal-ui.js
import { promptModalUi } from '../constants/prompt-modal-ui.js';
```

通过 `setup()` 暴露给模板：

```js
setup() {
  return { promptUi: promptModalUi };
},
```

该常量的作用：
- **缩小宽度**：`max-w-sm`（384px），适合轻量对话框，避免默认 `max-w-lg` 过宽
- **去掉分割线**：`divide-y-0` 消除 header / body / footer 之间的 `divide-y`
- **统一间距**：不区分 `sm` 断点，移动端与桌面端一致

## Confirm 对话框模板

用于破坏性操作（删除等）的二次确认。

```vue
<UModal v-model:open="deleteOpen" :title="$t('xxx.confirmTitle')" :ui="promptUi">
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
- 描述文本放在 `#body`，不使用 `:description` prop（后者会挤在 header 中）
- 破坏性操作的确认按钮用 `color="error"`
- 非破坏性操作的确认按钮用默认 primary 色

## Prompt 对话框模板

用于单行文本输入（重命名、编辑等）。

```vue
<UModal v-model:open="editOpen" :title="$t('xxx.editTitle')" :ui="promptUi">
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
- `autofocus` 让输入框自动获焦
- `@keydown.enter` 支持回车确认
- 确认按钮在输入为空时 `:disabled`

## Footer 按钮规范

- 按钮区域使用 `<div class="flex w-full justify-end gap-2">` 包裹，右对齐
- 取消按钮：`variant="ghost" color="neutral"`
- 确认按钮：默认 primary 色，破坏性操作用 `color="error"`
- 支持 `:loading` 状态防止重复提交

## 现有使用示例

| 文件 | 用途 |
|------|------|
| `ui/src/components/TopicItemActions.vue` | Topic 重命名（prompt）+ 删除确认（confirm） |
| `ui/src/components/user/UserProfilePanel.vue` | 昵称编辑（prompt） |
