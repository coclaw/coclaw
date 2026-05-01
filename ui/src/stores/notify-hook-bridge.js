/**
 * Notify 钩子桥接 — 把真实 notify / i18n 注入到 claws.store。
 *
 * 注册机制：本模块导入时自动向 claws.store 注册回调，
 * 因此必须在 claws.store 的 onRtcUnrecoverable 被首次触发前 import（通常在 app 入口）。
 *
 * 设计动机：claws.store 不直接 import use-notify / i18n，
 * 避免 @nuxt/ui 桶口里 useResizable 等 composable 的 '#imports'（Node subpath imports）
 * 把所有 transitively import 到 claws.store 的测试链路拖炸（vitest 未装 @nuxt/ui/vite 插件）。
 */
import { __registerNotifyHooks } from './claws.store.js';
import { useNotify } from '../composables/use-notify.js';
import { i18n } from '../i18n/index.js';

__registerNotifyHooks({
	notify: (opts) => useNotify().warning(opts),
	t: (key, params) => i18n.global.t(key, params),
});
