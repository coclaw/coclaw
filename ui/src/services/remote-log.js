/**
 * 远程日志推送服务（per-tab 单例）
 *
 * 将诊断日志缓冲并通过 RTC 信令 WS 通道推送到 CoClaw server。
 * 自动订阅 SignalingConnection 状态，连接可用时 flush 缓冲区。
 */
import { useSignalingConnection } from './signaling-connection.js';

const MAX_BUFFER = 1000;
const BATCH_SIZE = 20;

class RemoteLog {
	constructor() {
		/** @type {{ ts: number, text: string }[]} */
		this.__buffer = [];
		/** @type {((msg: object) => void) | null} */
		this.__sender = null;
		this.__flushing = false;
	}

	/**
	 * 注入/移除发送函数
	 * @param {((msg: object) => void) | null} fn
	 */
	setSender(fn) {
		this.__sender = fn;
		if (fn && this.__buffer.length > 0) {
			this.__flush().catch(() => {});
		}
	}

	/**
	 * 推送一条远程诊断日志
	 * @param {string} text - 可读文本描述（不含时间戳，内部自动附加）
	 */
	log(text) {
		if (this.__buffer.length >= MAX_BUFFER) {
			this.__buffer.shift();
		}
		this.__buffer.push({ ts: Date.now(), text });
		if (this.__sender && !this.__flushing) {
			this.__flush().catch(() => {});
		}
	}

	async __flush() {
		if (this.__flushing) return;
		this.__flushing = true;
		try {
			while (this.__buffer.length > 0 && this.__sender) {
				const batch = this.__buffer.slice(0, BATCH_SIZE);
				try {
					this.__sender({ type: 'log', logs: batch });
					this.__buffer.splice(0, batch.length);
				} catch {
					break;
				}
				await new Promise(r => setTimeout(r, 0));
			}
		} finally {
			this.__flushing = false;
		}
	}
}

// --- 单例 ---
// TODO: logout 时未清空 buffer，若换用户登录会将旧用户的缓冲日志发出。
//       当前诊断日志不含敏感内容，暂可接受；后续可在 logout 时清空 buffer。

let instance = null;

/**
 * 获取 RemoteLog 单例。首次调用时自动订阅 SignalingConnection 状态。
 * @returns {RemoteLog}
 */
export function useRemoteLog() {
	if (instance) return instance;
	instance = new RemoteLog();
	const sigConn = useSignalingConnection();
	sigConn.on('state', (state) => {
		if (state === 'connected') {
			instance.setSender((msg) => sigConn.__sendRaw(msg));
		} else {
			instance.setSender(null);
		}
	});
	// 桥接 SignalingConnection 的 log 事件（避免 sig→remote-log 循环引用）
	sigConn.on('log', (text) => instance.log(text));
	if (sigConn.state === 'connected') {
		instance.setSender((msg) => sigConn.__sendRaw(msg));
	}
	return instance;
}

/**
 * 便捷函数：推送一条远程诊断日志。
 * 首次调用时自动初始化单例。
 * @param {string} text
 */
export function remoteLog(text) {
	useRemoteLog().log(text);
}

/** @internal 仅供测试重置 */
export function __resetRemoteLog() {
	if (instance) {
		instance.setSender(null);
		instance.__buffer.length = 0;
		instance.__flushing = false;
	}
	instance = null;
}

export { RemoteLog, MAX_BUFFER, BATCH_SIZE };
