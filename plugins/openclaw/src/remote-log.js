/**
 * 远程日志推送模块
 *
 * 将诊断日志缓冲并通过 WS 通道推送到 CoClaw server。
 * 单例模式——各模块直接 import { remoteLog } 使用。
 *
 * link-UNSAFE：buffer / sender / flushing 都是模块级状态。`--link` 模式下
 * hook 实例可能从未被 setSender 注入 → hook 路径调 remoteLog 会落到没装
 * sender 的实例 → 静默丢日志。**不要在 hook 回调内调用 remoteLog**；
 * 要发就用 hook 入参里的 logger。详见 docs/module-boundaries.md。
 */

const MAX_BUFFER = 1000;
const BATCH_SIZE = 20;

/** @type {{ ts: number, text: string }[]} */
const buffer = [];

/** @type {((msg: object) => void) | null} */
let sender = null;

let flushing = false;

/**
 * 注入/移除发送函数。由 RealtimeBridge 在 WS 连接/断开时调用。
 * @param {((msg: object) => void) | null} fn
 */
export function setSender(fn) {
	sender = fn;
	if (fn && buffer.length > 0) {
		flush().catch(() => {});
	}
}

/**
 * 推送一条远程诊断日志。
 * @param {string} text - 可读文本描述（不含时间戳，内部自动附加）
 */
export function remoteLog(text) {
	if (buffer.length >= MAX_BUFFER) {
		buffer.shift();
	}
	buffer.push({ ts: Date.now(), text });
	if (sender && !flushing) {
		flush().catch(() => {});
	}
}

async function flush() {
	if (flushing) return;
	flushing = true;
	try {
		while (buffer.length > 0 && sender) {
			const batch = buffer.slice(0, BATCH_SIZE);
			try {
				sender({ type: 'log', logs: batch });
				buffer.splice(0, batch.length);
			} catch {
				break;
			}
			await new Promise(r => setTimeout(r, 0));
		}
	} finally {
		flushing = false;
	}
}

// 测试用：重置内部状态
export function __reset() {
	buffer.length = 0;
	sender = null;
	flushing = false;
}

export { buffer as __buffer, BATCH_SIZE as __BATCH_SIZE, MAX_BUFFER as __MAX_BUFFER };
