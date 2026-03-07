---
name: ui-notify
description: Use the global notify (toast) mechanism in CoClaw UI. Covers usage pattern, testing mock, and when to use or skip notify.
---

# Global Notify (Toast)

CoClaw UI 封装了 `useNotify()` composable（位于 `ui/src/composables/use-notify.js`），基于 Nuxt UI 的 `useToast`。

## 使用方式

```js
import { useNotify } from '../composables/use-notify.js';

export default {
  setup() {
    return { notify: useNotify() };
  },
  methods: {
    async doSomething() {
      try {
        await someAction();
        this.notify.success(this.$t('some.successKey'));
      } catch (err) {
        this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('some.fallbackKey'));
      }
    },
  },
};
```

### API

四个级别方法，参数可传字符串或对象：

| 方法 | 默认时长 | 用途 |
|------|---------|------|
| `notify.success(titleOrOpts)` | 3s | 操作成功 |
| `notify.info(titleOrOpts)` | 3s | 信息提示 |
| `notify.warning(titleOrOpts)` | 5s | 警告 |
| `notify.error(titleOrOpts)` | 8s | 错误 |

```js
// 简单用法
notify.success('保存成功');

// 完整用法
notify.info({ title: '已复制', description: '内容已复制到剪贴板', duration: 2000 });
```

## 使用原则

- **操作反馈统一走 notify**，禁止在页面内用 inline `<p>` 文本展示操作状态
- **可感知的成功操作可省略 notify**：如切换主题/语言等用户能直接观察到变化的操作
- **错误始终 notify**：所有失败操作都应通过 `notify.error()` 告知用户

## 关键注意事项

### 必须在 `setup()` 中初始化

`useNotify()` 内部调用 Nuxt UI 的 `useToast()`，它依赖 Vue 的 injection context。**必须在 `setup()` 中调用**，不能在 `mounted()` 或 `methods` 中首次调用。

### 单元测试必须 mock

`useNotify` 间接导入 `@nuxt/ui/composables`（`useToast`），在 Vitest 环境下会触发 `#imports` 解析错误。测试使用了 `useNotify` 的组件时，**必须 mock 该 composable**：

```js
import { vi } from 'vitest';

vi.mock('../composables/use-notify.js', () => ({
  useNotify: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));
```

路径根据测试文件与 composable 的相对位置调整。
