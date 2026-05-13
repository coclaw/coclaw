/**
 * 通用异步原语。
 */

/**
 * 可中断的 sleep。
 * - 不传 signal：等价于 `new Promise(r => setTimeout(r, timeout))`
 * - 传 signal：到点 resolve；signal 已 abort 或途中 abort 立即 reject
 * @param {number} timeout - 毫秒数
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<void>}
 */
export function sleep(timeout, signal) {
	return new Promise((resolve, reject) => {
		if (!signal) {
			setTimeout(resolve, timeout);
			return;
		}
		if (signal.aborted) {
			reject(abortReason(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, timeout);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * 从 AbortSignal 取出 reject 用的 reason。
 * - signal.reason 是 Error 实例 → 直接用（DOMException 是 Error 子类，命中此分支）
 * - signal.reason 是字符串 → 包成 Error 携带文案
 * - 其它（含 undefined / 老浏览器没有 .reason）→ 通用 Error
 *
 * baseline 浏览器（Safari 15.0~15.3 / Firefox 90）不支持 signal.reason，会走通用 Error 分支。
 * @param {AbortSignal} signal - 已 aborted 或正在 reject 的信号
 * @returns {Error}
 */
function abortReason(signal) {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === 'string') return new Error(`aborted: ${reason}`);
	return new Error('aborted');
}
