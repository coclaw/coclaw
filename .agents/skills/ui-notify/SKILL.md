---
name: ui-notify
description: CoClaw UI 全局 notify (toast) 机制的使用规范与测试 mock，含 store 等非组件层的接入方式。Use when 需要添加操作反馈通知、判断是否应该 notify，或要在 store/工具层触发通知。
---

# Global Notify (Toast)

CoClaw UI 封装了 `useNotify()` composable（`ui/src/composables/use-notify.js`），基于 Nuxt UI 的 `useToast`。

## 使用方式（组件 / view 层）

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

**必须在 `setup()` 中初始化**：`useToast()` 依赖 Vue injection context，不能在 `mounted()` 或 `methods` 中首次调用。

### API

四个级别方法，参数可传字符串或对象：

| 方法 | 默认时长 | 用途 |
|------|---------|------|
| `notify.success(titleOrOpts)` | 3s | 操作成功 |
| `notify.info(titleOrOpts)` | 3s | 信息提示 |
| `notify.warning(titleOrOpts)` | 5s | 警告 |
| `notify.error(titleOrOpts)` | 8s | 错误 |

```js
notify.success('保存成功');
notify.info({ title: '已复制', description: '内容已复制到剪贴板', duration: 2000 });
```

## 使用原则（何时 notify）

- **需要弹提示时统一走 `useNotify()`**（别直接 `useToast()`、别手搭提示条）；**操作失败始终 notify**——没有内联反馈位的失败（如复制失败）必须 toast。
- **成功自明可省**：界面已就地反映结果（列表已更新、主题/语言已切换）就不弹成功 toast。
- 有意排除项（完整渠道判据见用户级 `ui-design-taste` skill 的 feedback-channels 篇）：
  - **复制类成功用就地短暂反馈**（「已复制」约 3s 自动复位），别弹 toast——现成先例：`ProviderOAuthLoginStep` 复制成功就地显示、失败才 notify；
  - **表单字段级校验错误走内联红字**，字段承载不了的（IO/超时/通道断）才升级 toast；
  - **用户主动取消静默**，取消不是失败；
  - **随渲染的被动加载失败用内联错误卡**、别连环 toast——但被动**系统级**故障仍走 notify（现成先例：RTC 不可恢复故障经 bridge notify.warning）；
  - **已有常驻内联错误的步骤，重试失败别再叠 toast**（须在代码处就近注明理由）。

## 分层红线：store / utils / services 禁止直接 import

`use-notify.js` 经 `@nuxt/ui/composables` 桶口把所有 composable 拉进来，其中含 `#imports`（Node subpath imports，仅 `@nuxt/ui/vite` 插件在 dev/build 注册后可解析）。`vitest.config.js` 不挂该插件——**任何 transitively import 到它的测试链路整套炸**（`Package import specifier "#imports" is not defined`）。组件 / view / `main.js` / `App.vue` 是插件目标范围，静态 import 没问题；**store、utils、services 一律禁止**（store 直接 import `i18n/index.js` 同理，翻译走注入的 `t`）。

已验证的死路，别再试：深路径 `@nuxt/ui/composables/useToast`、Vite alias `#imports`、给 vitest 挂 `@nuxt/ui/vite`、动态 import（违反 ui 工作区约束）。

store 层要触发 notify，走依赖注入（现成范式：`ui/src/stores/claws.store.js` + `ui/src/stores/notify-hook-bridge.js`）：

1. store 顶部持 `_notifyHooks` 默认 no-op，导出 `__registerNotifyHooks(hooks)`
2. `notify-hook-bridge.js` 启动期接线：App.vue 的 `setup()` 调 `wireNotifyHooks(useNotify())`，早于任何远端触发点
3. 远离 setup 时机的回调（如 Capacitor 分享回调）用 `getSharedNotifier()` 取启动期领好的 notifier——未接线时为 null，调用要 `?.` 保护

> bridge 文件本身在 `stores/` 下、静态 import i18n 做接线——它是这条红线的**唯一钦定例外**（单向 import store、不进 store 的测试链路），别当违例改掉，也别照它的样子在别的 store 里直接 import。

## 测试 mock（按层分两种，别用错）

**组件测试**（组件直接 import use-notify）——mock 该 composable：

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

路径按测试文件与 composable 的相对位置调整。

**store 测试**（store 走 DI）——不 vi.mock，直接在 `beforeEach` 里注入：

```js
__registerNotifyHooks({ notify: vi.fn(), t: (key) => key });
```
