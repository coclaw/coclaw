/**
 * Notify 钩子桥接 — 把 Vue setup 期领好的 notifier 接入 claws.store hook，
 * 同时供非 setup 上下文（如 Capacitor 分享回调）按需取用。
 *
 * 调用契约：必须在 Vue setup 内（即 useNotify() 的合法时机）调用 wireNotifyHooks()，
 * 且要在任何远端触发点（claws.store 的 onRtcUnrecoverable / Capacitor share 回调）
 * 首次触发前完成。当前由 App.vue 的 setup() 在 main.js 的 app.mount() 时调用，
 * 早于 initCapacitorApp() 与任何 ClawConnection 建立。
 *
 * 设计动机：
 * 1. claws.store 不直接 import use-notify / i18n，避免 @nuxt/ui 桶口里 useResizable 等
 *    composable 的 '#imports'（Node subpath imports）把所有 transitively import 到
 *    claws.store 的测试链路拖炸（vitest 未装 @nuxt/ui/vite 插件）。
 * 2. notifier 在 setup 内一次性领好后由本模块持有，供"远离 setup 时机"的回调
 *    （Capacitor share 回调等）按需取用，避免它们各自 useNotify() 触发 Vue inject 警告。
 */
import { __registerNotifyHooks } from './claws.store.js';
import { i18n } from '../i18n/index.js';

/** @type {{ success: Function, info: Function, warning: Function, error: Function } | null} */
let _shared = null;

/**
 * 启动期一次性接线。需在 Vue setup 内调用。
 * @param {{ success: Function, info: Function, warning: Function, error: Function }} notifier - useNotify() 返回的 notifier 对象
 */
export function wireNotifyHooks(notifier) {
	_shared = notifier;
	__registerNotifyHooks({
		notify: (opts) => notifier.warning(opts),
		t: (key, params) => i18n.global.t(key, params),
	});
}

/**
 * 取启动期已领好的 notifier。Vue setup 之外的回调里使用，避免 useNotify() 触发 inject 警告。
 * 在 wireNotifyHooks() 尚未跑过时返回 null，调用方应做空值保护（如 `?.info(...)`）。
 * @returns {{ success: Function, info: Function, warning: Function, error: Function } | null}
 */
export function getSharedNotifier() {
	return _shared;
}
