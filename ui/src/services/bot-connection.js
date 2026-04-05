/**
 * 单个 Bot 的数据通道连接
 * 职责：RPC over DataChannel、WebRtcConnection 引用管理、事件分发、连接就绪等待
 * 无 Vue 依赖，纯 JS
 *
 * WS 信令管理已迁移至 SignalingConnection（per-tab 单例）
 */
import { useSignalingConnection } from './signaling-connection.js';
import { remoteLog } from './remote-log.js';

/** 默认请求超时（发送后等待响应），0 表示永不超时 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** 默认连接等待超时（等待 DC 就绪） */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** 短暂抖动 vs 实质断连分界 */
const BRIEF_DISCONNECT_MS = 5000;
const TERMINAL_STATUSES = new Set(['ok', 'error']);

// 导出常量供外部模块使用
export { BRIEF_DISCONNECT_MS, DEFAULT_CONNECT_TIMEOUT_MS };

/**
 * Per-bot 数据通道连接
 *
 * 事件:
 * - `event:<name>` — DataChannel 推送事件 (data: payload)
 */
export class BotConnection {
	/**
	 * @param {string} botId
	 */
	constructor(botId) {
		this.botId = String(botId);

		// RPC pending
		this.__pending = new Map();
		this.__counter = 1;

		// 事件监听
		this.__listeners = new Map();

		/** @type {import('./webrtc-connection.js').WebRtcConnection | null} */
		this.__rtc = null;

		// 连接就绪等待队列
		/** @type {{ resolve: Function, reject: Function, timer: number|null }[]} */
		this.__readyWaiters = [];

		/**
		 * 由外层（bots.store）注入的回调：触发 RTC 重连（fire-and-forget）
		 * @type {(() => void) | null}
		 */
		this.__onTriggerReconnect = null;

		/**
		 * 由外层（bots.store）注入的回调：获取当前 rtcPhase
		 * @type {(() => string) | null}
		 */
		this.__onGetRtcPhase = null;
	}

	/** @returns {import('./webrtc-connection.js').WebRtcConnection | null} */
	get rtc() { return this.__rtc; }

	/** 设置 RTC 连接引用，并 resolve 所有等待中的 waitReady */
	setRtc(rtcConn) {
		if (rtcConn && !rtcConn.isReady) {
			console.warn('[BotConn] setRtc called with non-ready RTC, waiters may receive unusable connection');
		}
		this.__rtc = rtcConn;
		this.__resolveAllWaiters();
	}

	/** 清除 RTC 连接引用并 reject 所有挂起请求和等待（DC 已不可用） */
	clearRtc() {
		const pendingCount = this.__pending.size;
		const waiterCount = this.__readyWaiters.length;
		if (pendingCount || waiterCount) {
			remoteLog(`conn.clearRtc bot=${this.botId} pending=${pendingCount} waiters=${waiterCount}`);
		}
		this.__rtc = null;
		this.__rejectAllWaiters('RTC connection lost', 'RTC_LOST');
		this.__rejectAllPending('RTC connection lost', 'RTC_LOST');
	}

	/** 断开：关闭 RTC + reject pending/waiters + 释放 connId */
	disconnect() {
		console.debug('[BotConn] disconnect botId=%s', this.botId);
		if (this.__rtc) {
			try { this.__rtc.close(); } catch (err) { console.debug('[BotConn] rtc.close() failed: %s', err?.message); }
			this.__rtc = null;
		}
		this.__rejectAllWaiters('connection closed', 'DC_CLOSED');
		this.__rejectAllPending('connection closed');
		useSignalingConnection().releaseConnId(this.botId);
	}

	/**
	 * 等待 DataChannel 就绪
	 * @param {number} [timeoutMs] - 超时 ms，默认 DEFAULT_CONNECT_TIMEOUT_MS
	 * @returns {Promise<void>}
	 */
	waitReady(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
		if (this.__rtc?.isReady) return Promise.resolve();

		// 若 rtcPhase 为 failed（重试耗尽），主动触发重连
		const phase = this.__onGetRtcPhase?.();
		if (phase === 'failed') {
			this.__onTriggerReconnect?.();
		}

		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, timer: null };
			waiter.timer = setTimeout(() => {
				this.__removeWaiter(waiter);
				const err = new Error('connect timeout');
				err.code = 'CONNECT_TIMEOUT';
				remoteLog(`conn.waitReady.timeout bot=${this.botId} timeout=${timeoutMs}ms phase=${this.__onGetRtcPhase?.() ?? '?'}`);
				reject(err);
			}, timeoutMs);
			this.__readyWaiters.push(waiter);
		});
	}

	/**
	 * 发送 RPC 请求（自动等待连接就绪）
	 * @param {string} method
	 * @param {object} [params]
	 * @param {object} [options]
	 * @param {(payload: object) => void} [options.onAccepted] - 两阶段模式回调
	 * @param {(status: string, payload: object) => void} [options.onUnknownStatus]
	 * @param {number} [options.timeout] - 请求超时 ms（0 = 永不超时），默认 30s
	 * @param {number} [options.connectTimeout] - 连接等待超时 ms，默认 30s
	 * @returns {Promise<object>}
	 */
	request(method, params = {}, options = {}) {
		const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;

		const doSend = () => {
			const id = `ui-${Date.now()}-${this.__counter++}`;
			return new Promise((resolve, reject) => {
				const waiter = { resolve, reject };
				if (options.onAccepted) waiter.onAccepted = options.onAccepted;
				if (options.onUnknownStatus) waiter.onUnknownStatus = options.onUnknownStatus;
				const timeoutMs = options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
				if (timeoutMs > 0) {
					waiter.timer = setTimeout(() => {
						this.__pending.delete(id);
						const err = new Error('rpc timeout');
						err.code = 'RPC_TIMEOUT';
						remoteLog(`rpc.timeout bot=${this.botId} method=${method} timeout=${timeoutMs}ms`);
						reject(err);
					}, timeoutMs);
				}
				this.__pending.set(id, waiter);
				this.__rtc.send({ type: 'req', id, method, params })
					.catch((sendErr) => {
						if (!this.__pending.has(id)) return;
						this.__pending.delete(id);
						if (waiter.timer) clearTimeout(waiter.timer);
						const err = new Error('rtc send failed');
						err.code = 'RTC_SEND_FAILED';
						remoteLog(`rpc.sendFailed bot=${this.botId} method=${method} err=${sendErr?.message}`);
						reject(err);
					});
			});
		};

		if (this.__rtc?.isReady) return doSend();
		return this.waitReady(connectTimeout).then(doSend);
	}

	/** @param {string} event @param {Function} cb */
	on(event, cb) {
		const set = this.__listeners.get(event) ?? new Set();
		set.add(cb);
		this.__listeners.set(event, set);
	}

	/** @param {string} event @param {Function} cb */
	off(event, cb) {
		this.__listeners.get(event)?.delete(cb);
	}

	// --- 内部方法 ---

	__emit(event, data) {
		const cbs = this.__listeners.get(event);
		if (!cbs) return;
		for (const cb of cbs) {
			try { cb(data); }
			catch (e) { console.error('[BotConn] listener error:', e); }
		}
	}

	/** DataChannel 消息处理（由 WebRtcConnection 回调） */
	__onRtcMessage(payload) {
		if (payload.type === 'res' && payload.id) {
			this.__handleRpcResponse(payload);
		} else if (payload.type === 'event' && payload.event) {
			this.__emit(`event:${payload.event}`, payload.payload);
		}
	}

	__handleRpcResponse(payload) {
		const waiter = this.__pending.get(payload.id);
		if (!waiter) {
			console.warn('[BotConn] unmatched rpc response id=%s ok=%s botId=%s', payload.id, payload.ok, this.botId);
			return;
		}

		// 失败：立即 reject
		if (payload.ok === false) {
			this.__pending.delete(payload.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			const err = new Error(payload?.error?.message ?? 'rpc failed');
			err.code = payload?.error?.code ?? 'RPC_FAILED';
			remoteLog(`rpc.failed bot=${this.botId} code=${err.code} err=${err.message}`);
			waiter.reject(err);
			return;
		}

		const status = payload.payload?.status;

		// 两阶段 accepted
		if (waiter.onAccepted && status === 'accepted') {
			waiter.onAccepted(payload.payload);
			return;
		}

		// 非两阶段：任何 ok=true 直接 resolve
		if (!waiter.onAccepted) {
			this.__pending.delete(payload.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(payload.payload ?? {});
			return;
		}

		// 两阶段终态
		if (TERMINAL_STATUSES.has(status)) {
			this.__pending.delete(payload.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(payload.payload ?? {});
			return;
		}

		// 未知中间态
		console.error('[BotConn] unknown intermediate status=%s id=%s', status, payload.id);
		if (waiter.onUnknownStatus) {
			waiter.onUnknownStatus(status, payload.payload);
		}
	}

	__rejectAllPending(message, code = 'DC_CLOSED') {
		if (this.__pending.size) {
			remoteLog(`conn.rejectPending bot=${this.botId} count=${this.__pending.size} code=${code}`);
		}
		for (const waiter of this.__pending.values()) {
			if (waiter.timer) clearTimeout(waiter.timer);
			const err = new Error(message);
			err.code = code;
			waiter.reject(err);
		}
		this.__pending.clear();
	}

	/** resolve 并清空所有 readyWaiters */
	__resolveAllWaiters() {
		const waiters = this.__readyWaiters.splice(0);
		for (const w of waiters) {
			if (w.timer) clearTimeout(w.timer);
			w.resolve();
		}
	}

	/** reject 并清空所有 readyWaiters */
	__rejectAllWaiters(message, code) {
		const waiters = this.__readyWaiters.splice(0);
		for (const w of waiters) {
			if (w.timer) clearTimeout(w.timer);
			const err = new Error(message);
			err.code = code;
			w.reject(err);
		}
	}

	/** 从 readyWaiters 中移除指定 waiter */
	__removeWaiter(waiter) {
		const idx = this.__readyWaiters.indexOf(waiter);
		if (idx !== -1) this.__readyWaiters.splice(idx, 1);
	}
}
