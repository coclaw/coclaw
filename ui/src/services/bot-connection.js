/**
 * 单个 Bot 的 WebSocket 持久连接
 * 职责：连接生命周期、RPC 协议、心跳、自动重连、事件分发
 * 无 Vue 依赖，纯 JS
 */
import { resolveApiBaseUrl } from './http.js';

const HB_PING_MS = 25_000;
const HB_TIMEOUT_MS = 45_000;
const HB_MAX_MISS = 2; // 2 次 miss（~90s）再判定断连
const DEFAULT_RPC_TIMEOUT_MS = 30 * 60_000; // 30 分钟兜底
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const RECONNECT_JITTER = 0.3;
/** 前台恢复：连接探测超时 */
const PROBE_TIMEOUT_MS = 2500;
/** 前台恢复：超过此时长无消息则假定连接已死 */
const ASSUME_DEAD_MS = 45_000;
/** 短暂抖动 vs 实质断连分界 */
const BRIEF_DISCONNECT_MS = 5000;
/** 防重入节流（visibilitychange + app:foreground） */
const FOREGROUND_THROTTLE_MS = 500;
const TERMINAL_STATUSES = new Set(['ok', 'error']);

// 导出常量供外部模块使用
export { BRIEF_DISCONNECT_MS };

function resolveWsUrl(httpBaseUrl, botId) {
	const url = new URL(httpBaseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/api/v1/bots/stream';
	url.searchParams.set('role', 'ui');
	url.searchParams.set('botId', botId);
	return url.toString();
}

/**
 * Per-bot 持久 WS 连接
 *
 * 事件:
 * - `state`          — 连接状态变更 (data: 'connecting' | 'connected' | 'disconnected')
 * - `event:<name>`   — server 推送事件 (data: payload)
 * - `session-expired` — session 过期
 * - `bot-unbound`    — bot 已解绑
 */
export class BotConnection {
	/**
	 * @param {string} botId
	 * @param {object} [options]
	 * @param {string} [options.baseUrl] - HTTP API base URL
	 * @param {Function} [options.WebSocket] - WebSocket 构造函数（测试注入）
	 */
	constructor(botId, options = {}) {
		this.botId = String(botId);
		this.__baseUrl = options.baseUrl ?? resolveApiBaseUrl();
		this.__WS = options.WebSocket ?? globalThis.WebSocket;

		this.__ws = null;
		this.__state = 'disconnected';
		this.__intentionalClose = false;

		// 重连
		this.__reconnectTimer = null;
		this.__reconnectDelay = INITIAL_RECONNECT_MS;

		// 心跳
		this.__hbInterval = null;
		this.__hbTimer = null;
		this.__hbMissCount = 0;

		// RPC pending
		this.__pending = new Map();
		this.__counter = 1;

		// 事件监听
		this.__listeners = new Map();

		// 传输模式（Phase 2）
		/** @type {'rtc' | 'ws' | null} */
		this.__transportMode = null;
		/** @type {import('./webrtc-connection.js').WebRtcConnection | null} */
		this.__rtc = null;

		// visibility / foreground 恢复重连
		this.__boundVisibilityHandler = null;
		this.__boundForegroundHandler = null;
		this.__lastForegroundAt = 0; // 防重入节流

		// 连接感知时间戳
		/** @type {number} 最后一次确认连接活着的时间（收到任何 WS 消息时更新） */
		this.__lastAliveAt = 0;
		/** @type {((ts: number) => void) | null} 外部回调：每次确认连接存活时调用 */
		this.__onAlive = null;
		/** @type {number} 断连时间戳（state → disconnected 时记录） */
		this.__disconnectedAt = 0;
		/** @type {number | null} probe 定时器 */
		this.__probeTimer = null;
	}

	/** @returns {'disconnected' | 'connecting' | 'connected'} */
	get state() {
		return this.__state;
	}

	/** @returns {number} 最后一次确认连接存活的时间戳 */
	get lastAliveAt() {
		return this.__lastAliveAt;
	}

	/** @returns {number} 最近一次断连的时间戳（0 表示从未断连） */
	get disconnectedAt() {
		return this.__disconnectedAt;
	}

	/** @returns {number} 断连持续时长（ms），若未断连返回 0 */
	get disconnectDuration() {
		if (!this.__disconnectedAt || this.__state !== 'disconnected') return 0;
		return Date.now() - this.__disconnectedAt;
	}

	/** @returns {'rtc' | 'ws' | null} */
	get transportMode() {
		return this.__transportMode;
	}

	/** 设置 RTC 连接引用 */
	setRtc(rtcConn) { this.__rtc = rtcConn; }

	/** 清除 RTC 连接引用 */
	clearRtc() { this.__rtc = null; }

	/**
	 * 设置传输模式
	 * @param {'rtc' | 'ws' | null} mode
	 */
	setTransportMode(mode) {
		const prev = this.__transportMode;
		this.__transportMode = mode;
		console.debug('[BotConn] transportMode %s→%s botId=%s', prev, mode, this.botId);

		// RTC → WS 降级：reject RTC 侧的挂起请求
		if (prev === 'rtc' && mode === 'ws') {
			for (const [id, waiter] of this.__pending) {
				if (waiter.viaRtc) {
					clearTimeout(waiter.timer);
					const err = new Error('RTC connection lost');
					err.code = 'RTC_LOST';
					waiter.reject(err);
					this.__pending.delete(id);
				}
			}
		}
	}

	/** 建立连接（幂等） */
	connect() {
		if (this.__ws) return;
		console.debug('[BotConn] connect botId=%s', this.botId);
		this.__intentionalClose = false;
		if (typeof document !== 'undefined' && !this.__boundVisibilityHandler) {
			this.__boundVisibilityHandler = () => this.__onVisibilityChange();
			document.addEventListener('visibilitychange', this.__boundVisibilityHandler);
		}
		if (typeof window !== 'undefined' && !this.__boundForegroundHandler) {
			this.__boundForegroundHandler = () => this.__onAppForeground();
			window.addEventListener('app:foreground', this.__boundForegroundHandler);
		}
		this.__doConnect();
	}

	/** 主动断开，不再自动重连 */
	disconnect() {
		console.debug('[BotConn] disconnect botId=%s', this.botId);
		this.__intentionalClose = true;
		this.__clearReconnect();
		this.__cleanup();
		this.__setState('disconnected');
	}

	/**
	 * 发送 RPC 请求
	 * @param {string} method
	 * @param {object} [params]
	 * @param {object} [options]
	 * @param {(payload: object) => void} [options.onAccepted] - 两阶段模式回调
	 * @param {(status: string, payload: object) => void} [options.onUnknownStatus]
	 * @param {number} [options.timeout] - 超时 ms
	 * @returns {Promise<object>}
	 */
	request(method, params = {}, options = {}) {
		const rtcReady = this.__transportMode === 'rtc' && this.__rtc?.isReady;

		// RTC 可用时走 DataChannel（WebRtcConnection.send 内部自动分片）
		if (rtcReady) {
			const id = `ui-${Date.now()}-${this.__counter++}`;
			return new Promise((resolve, reject) => {
				const waiter = { resolve, reject, viaRtc: true };
				if (options.onAccepted) waiter.onAccepted = options.onAccepted;
				if (options.onUnknownStatus) waiter.onUnknownStatus = options.onUnknownStatus;
				const timeoutMs = options.timeout ?? DEFAULT_RPC_TIMEOUT_MS;
				waiter.timer = setTimeout(() => {
					this.__pending.delete(id);
					const err = new Error('rpc timeout');
					err.code = 'RPC_TIMEOUT';
					reject(err);
				}, timeoutMs);
				this.__pending.set(id, waiter);
				this.__rtc.send({ type: 'req', id, method, params })
					.catch(() => {
						if (!this.__pending.has(id)) return;
						this.__pending.delete(id);
						clearTimeout(waiter.timer);
						const err = new Error('rtc send failed');
						err.code = 'RTC_SEND_FAILED';
						reject(err);
					});
			});
		}

		// RTC 不可用时主动降级到 WS，确保 __onMessage 不再过滤 WS event
		if (this.__transportMode === 'rtc' && !rtcReady) {
			console.debug('[BotConn] RTC not ready, degrade to WS botId=%s', this.botId);
			this.setTransportMode('ws');
		}

		// transportMode === 'ws' / null 均走 WS
		if (!this.__ws || this.__ws.readyState !== 1) {
			const err = new Error('not connected');
			err.code = 'WS_CLOSED';
			return Promise.reject(err);
		}
		const id = `ui-${Date.now()}-${this.__counter++}`;
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, viaRtc: false };
			if (options.onAccepted) waiter.onAccepted = options.onAccepted;
			if (options.onUnknownStatus) waiter.onUnknownStatus = options.onUnknownStatus;
			const timeoutMs = options.timeout ?? DEFAULT_RPC_TIMEOUT_MS;
			waiter.timer = setTimeout(() => {
				this.__pending.delete(id);
				const err = new Error('rpc timeout');
				err.code = 'RPC_TIMEOUT';
				reject(err);
			}, timeoutMs);
			this.__pending.set(id, waiter);
			try {
				this.__ws.send(JSON.stringify({ type: 'req', id, method, params }));
			}
			catch {
				this.__pending.delete(id);
				if (waiter.timer) clearTimeout(waiter.timer);
				const err = new Error('ws send failed');
				err.code = 'WS_SEND_FAILED';
				reject(err);
			}
		});
	}

	/**
	 * 发送非 RPC 原始消息（用于 WebRTC 信令等）
	 * @param {object} payload - 完整消息对象，直接 JSON 序列化发送
	 * @returns {boolean} 是否发送成功
	 */
	sendRaw(payload) {
		if (!this.__ws || this.__ws.readyState !== 1) return false;
		try {
			this.__ws.send(JSON.stringify(payload));
			return true;
		}
		catch { return false; }
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

	__setState(newState) {
		if (this.__state === newState) return;
		const prev = this.__state;
		this.__state = newState;
		if (newState === 'disconnected') {
			this.__disconnectedAt = Date.now();
		}
		console.debug('[BotConn] state %s→%s botId=%s', prev, newState, this.botId);
		this.__emit('state', newState);
	}

	__doConnect() {
		this.__setState('connecting');
		const wsUrl = resolveWsUrl(this.__baseUrl, this.botId);
		let ws;
		try {
			ws = new this.__WS(wsUrl);
		}
		catch {
			this.__setState('disconnected');
			this.__scheduleReconnect();
			return;
		}
		this.__ws = ws;

		ws.addEventListener('open', () => {
			if (this.__ws !== ws) return;
			console.debug('[BotConn] ws open botId=%s', this.botId);
			this.__setState('connected');
			this.__reconnectDelay = INITIAL_RECONNECT_MS;
			this.__startHeartbeat();
		});

		ws.addEventListener('message', (event) => {
			if (this.__ws !== ws) return;
			this.__resetHbTimeout();
			this.__onMessage(event);
		});

		ws.addEventListener('close', (ev) => {
			if (this.__ws !== ws) return;
			console.debug('[BotConn] ws close botId=%s code=%d reason=%s', this.botId, ev.code, ev.reason);
			this.__clearHeartbeat();
			this.__clearProbe();
			// RTC 模式下 WS 断开不影响 RTC 请求
			if (this.__transportMode === 'rtc') {
				for (const [id, waiter] of this.__pending) {
					if (!waiter.viaRtc) {
						clearTimeout(waiter.timer);
						const err = new Error('connection closed');
						err.code = 'WS_CLOSED';
						waiter.reject(err);
						this.__pending.delete(id);
					}
				}
			} else {
				this.__rejectAllPending('connection closed');
			}
			this.__ws = null;
			if (!this.__intentionalClose) {
				this.__setState('disconnected');
				this.__scheduleReconnect();
			}
		});

		ws.addEventListener('error', () => {
			console.debug('[BotConn] ws error botId=%s', this.botId);
		});
	}

	__onMessage(event) {
		let payload;
		try {
			payload = JSON.parse(String(event.data ?? '{}'));
		}
		catch { return; }

		// 系统消息始终处理
		if (payload?.type === 'pong') return;

		// rtc 信令消息 → 转发给 WebRtcConnection
		if (payload?.type?.startsWith('rtc:')) {
			this.__emit('rtc', payload);
			return;
		}

		// session 过期（server 侧主动通知，预留）
		if (payload?.type === 'session.expired') {
			console.debug('[BotConn] session.expired botId=%s', this.botId);
			this.__emit('session-expired');
			this.disconnect();
			return;
		}

		// bot 解绑
		if (payload?.type === 'bot.unbound') {
			console.debug('[BotConn] bot.unbound botId=%s', this.botId);
			this.__emit('bot-unbound', payload);
			this.__intentionalClose = true;
			this.__clearReconnect();
			this.__cleanup();
			this.__setState('disconnected');
			return;
		}

		// 业务消息（res / event）：RTC 模式下忽略 WS 业务消息
		// 但需放行属于 WS 发出请求的响应（null→rtc 过渡期间的遗留请求）
		if (this.__transportMode === 'rtc') {
			if (payload?.type === 'res' && payload.id) {
				const waiter = this.__pending.get(payload.id);
				if (waiter && !waiter.viaRtc) {
					this.__handleRpcResponse(payload);
					return;
				}
			}
			return;
		}

		// WS 模式或 transportMode === null：走原有逻辑
		if (payload?.type === 'event' && payload.event) {
			this.__emit(`event:${payload.event}`, payload.payload);
			return;
		}

		// RPC 响应
		if (payload?.type === 'res' && payload.id) {
			this.__handleRpcResponse(payload);
		}
	}

	/** DataChannel 消息处理（由 WebRtcConnection 回调） */
	__onRtcMessage(payload) {
		if (this.__transportMode !== 'rtc') return;

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

	// --- 心跳 ---

	__startHeartbeat() {
		this.__clearHeartbeat();
		this.__hbMissCount = 0;
		this.__hbInterval = setInterval(() => {
			if (this.__ws?.readyState === 1) {
				try { this.__ws.send(JSON.stringify({ type: 'ping' })); }
				catch {}
			}
		}, HB_PING_MS);
		this.__resetHbTimeout();
	}

	__resetHbTimeout() {
		this.__hbMissCount = 0;
		this.__lastAliveAt = Date.now();
		if (this.__onAlive) this.__onAlive(this.__lastAliveAt);
		if (this.__hbTimer) clearTimeout(this.__hbTimer);
		this.__hbTimer = setTimeout(() => {
			this.__onHbMiss();
		}, HB_TIMEOUT_MS);
	}

	__onHbMiss() {
		this.__hbMissCount++;
		if (this.__hbMissCount < HB_MAX_MISS) {
			console.debug(
				'[BotConn] heartbeat miss (%d/%d) botId=%s',
				this.__hbMissCount, HB_MAX_MISS, this.botId,
			);
			if (this.__ws?.readyState === 1) {
				try { this.__ws.send(JSON.stringify({ type: 'ping' })); }
				catch {}
			}
			this.__hbTimer = setTimeout(() => {
				this.__onHbMiss();
			}, HB_TIMEOUT_MS);
			return;
		}
		console.warn(
			'[BotConn] heartbeat timeout (%d misses, ~%ds) botId=%s',
			this.__hbMissCount, this.__hbMissCount * HB_TIMEOUT_MS / 1000,
			this.botId,
		);
		try { this.__ws?.close(4000, 'heartbeat_timeout'); }
		catch {}
	}

	__clearHeartbeat() {
		if (this.__hbInterval) { clearInterval(this.__hbInterval); this.__hbInterval = null; }
		if (this.__hbTimer) { clearTimeout(this.__hbTimer); this.__hbTimer = null; }
		this.__hbMissCount = 0;
	}

	// --- 重连 ---

	__scheduleReconnect() {
		if (this.__intentionalClose || this.__reconnectTimer) return;
		const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
		const delay = Math.min(this.__reconnectDelay * jitter, MAX_RECONNECT_MS);
		console.debug('[BotConn] reconnect in %dms botId=%s', Math.round(delay), this.botId);
		this.__reconnectTimer = setTimeout(() => {
			this.__reconnectTimer = null;
			if (!this.__intentionalClose) {
				this.__reconnectDelay = Math.min(this.__reconnectDelay * 2, MAX_RECONNECT_MS);
				this.__doConnect();
			}
		}, delay);
	}

	__clearReconnect() {
		if (this.__reconnectTimer) {
			clearTimeout(this.__reconnectTimer);
			this.__reconnectTimer = null;
		}
	}

	// --- Visibility / Foreground 恢复重连 ---

	__onVisibilityChange() {
		if (typeof document === 'undefined') return;
		if (document.visibilityState !== 'visible') return;
		this.__handleForegroundResume('visibility');
	}

	__onAppForeground() {
		this.__handleForegroundResume('app:foreground');
	}

	/**
	 * 前台恢复统一入口（visibilitychange / app:foreground 共用）
	 * @param {string} source - 触发来源（日志用）
	 */
	__handleForegroundResume(source) {
		if (this.__intentionalClose) return;
		// 防重入节流：500ms 内不重复执行
		const now = Date.now();
		if (now - this.__lastForegroundAt < FOREGROUND_THROTTLE_MS) return;
		this.__lastForegroundAt = now;

		if (this.__state === 'disconnected') {
			// 已知断开 → 即时重连
			console.debug('[BotConn] %s → immediate reconnect botId=%s', source, this.botId);
			this.__clearReconnect();
			this.__reconnectDelay = INITIAL_RECONNECT_MS;
			this.__doConnect();
			return;
		}

		if (this.__state === 'connecting') return; // 正在重连中

		// state === 'connected'：根据 lastAliveAt 判断连接是否可能已死
		const elapsed = now - this.__lastAliveAt;
		if (elapsed > ASSUME_DEAD_MS) {
			console.debug('[BotConn] %s → assume dead (elapsed=%dms) botId=%s', source, elapsed, this.botId);
			this.forceReconnect();
		} else if (this.__lastAliveAt > 0 && elapsed > PROBE_TIMEOUT_MS) {
			// 超过探测超时时长未收到消息 → 有必要探测
			console.debug('[BotConn] %s → probe (elapsed=%dms) botId=%s', source, elapsed, this.botId);
			this.probe();
		}
		// elapsed <= PROBE_TIMEOUT_MS → 刚刚还收到过消息，无需探测

		// RTC 恢复：若 PC 处于 disconnected（NAT 映射可能已失效），主动 ICE restart
		if (this.__rtc?.tryIceRestart()) {
			console.debug('[BotConn] %s → proactive RTC ICE restart botId=%s', source, this.botId);
		}
	}

	/**
	 * 探测连接存活性：发送 ping，若 PROBE_TIMEOUT_MS 内无响应则 forceReconnect
	 */
	probe() {
		if (this.__probeTimer) return; // 已在探测中
		if (!this.__ws || this.__ws.readyState !== 1) {
			this.forceReconnect();
			return;
		}
		const aliveAtBefore = this.__lastAliveAt;
		try { this.__ws.send(JSON.stringify({ type: 'ping' })); }
		catch { this.forceReconnect(); return; }

		this.__probeTimer = setTimeout(() => {
			this.__probeTimer = null;
			// 若期间收到过消息，lastAliveAt 会被更新
			if (this.__lastAliveAt > aliveAtBefore) {
				console.debug('[BotConn] probe ok botId=%s', this.botId);
				return;
			}
			console.debug('[BotConn] probe timeout → forceReconnect botId=%s', this.botId);
			this.forceReconnect();
		}, PROBE_TIMEOUT_MS);
	}

	/**
	 * 强制重连：关闭当前 WS → 立即重新建连
	 * 不检查当前 state，适用于连接表面 connected 但实际已死的情况
	 */
	forceReconnect() {
		if (this.__intentionalClose) return;
		console.debug('[BotConn] forceReconnect botId=%s', this.botId);
		this.__clearProbe();
		this.__clearHeartbeat();
		this.__clearReconnect();
		const ws = this.__ws;
		this.__ws = null;
		if (ws) {
			// reject 非 RTC 的 pending（RTC 侧不受影响）
			if (this.__transportMode === 'rtc') {
				for (const [id, waiter] of this.__pending) {
					if (!waiter.viaRtc) {
						clearTimeout(waiter.timer);
						const err = new Error('connection closed');
						err.code = 'WS_CLOSED';
						waiter.reject(err);
						this.__pending.delete(id);
					}
				}
			} else {
				this.__rejectAllPending('connection closed');
			}
			try { ws.close(4000, 'force_reconnect'); }
			catch {}
		}
		this.__setState('disconnected');
		this.__reconnectDelay = INITIAL_RECONNECT_MS;
		this.__doConnect();
	}

	__clearProbe() {
		if (this.__probeTimer) {
			clearTimeout(this.__probeTimer);
			this.__probeTimer = null;
		}
	}

	// --- 清理 ---

	__cleanup() {
		this.__clearHeartbeat();
		this.__clearProbe();
		if (this.__boundVisibilityHandler && typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.__boundVisibilityHandler);
			this.__boundVisibilityHandler = null;
		}
		if (this.__boundForegroundHandler && typeof window !== 'undefined') {
			window.removeEventListener('app:foreground', this.__boundForegroundHandler);
			this.__boundForegroundHandler = null;
		}
		const ws = this.__ws;
		this.__ws = null;
		if (ws) {
			try { ws.close(1000, 'disconnect'); }
			catch {}
		}
		// 完整拆除时关闭 RTC 连接并重置状态
		// rtcInstances map 中的残留在下次 initRtcAndSelectTransport 时会被清理
		if (this.__rtc) {
			try { this.__rtc.close(); } catch {}
			this.__rtc = null;
		}
		this.__transportMode = null;
		this.__rejectAllPending('connection closed');
	}

	__rejectAllPending(message) {
		for (const waiter of this.__pending.values()) {
			if (waiter.timer) clearTimeout(waiter.timer);
			const err = new Error(message);
			err.code = 'WS_CLOSED';
			waiter.reject(err);
		}
		this.__pending.clear();
	}
}
