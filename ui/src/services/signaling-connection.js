/**
 * RTC 信令 WS 连接（per-tab 单例）
 *
 * 职责：管理唯一的信令 WS（/api/v1/rtc/signal）、connId 管理、
 * 心跳、自动重连、前台恢复事件。
 * 无 Vue 依赖，纯 JS。
 */
import { resolveApiBaseUrl } from './http.js';
import { isCapacitorApp } from '../utils/platform.js';

const HB_PING_MS = 25_000;
const HB_TIMEOUT_MS = 45_000;
const HB_MAX_MISS = 2;
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const RECONNECT_JITTER = 0.3;
/** 前台恢复：连接探测超时 */
const PROBE_TIMEOUT_MS = 2500;
/** 前台恢复：超过此时长无消息则假定连接已死 */
const ASSUME_DEAD_MS = 45_000;
/** 防重入节流（visibilitychange + app:foreground；network:online 豁免） */
const FOREGROUND_THROTTLE_MS = 500;
/** ensureConnected verify 冷却期 */
const VERIFY_COOLDOWN_MS = 5000;

function resolveSignalingWsUrl(httpBaseUrl) {
	const url = new URL(httpBaseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/api/v1/rtc/signal';
	return url.toString();
}

/**
 * Per-tab 信令 WS 连接
 *
 * 事件:
 * - `state`             — WS 状态变更 (data: 'connecting' | 'connected' | 'disconnected')
 * - `rtc`               — 入站 RTC 信令 (data: { clawId, type, payload })
 * - `foreground-resume`  — 前台恢复 / 网络切换 (data: { source })，仅移动端或 network:online
 * - `log`               — 诊断日志 (data: string)，由 remote-log 桥接推送
 */
export class SignalingConnection {
	/**
	 * @param {object} [options]
	 * @param {string} [options.baseUrl] - HTTP API base URL
	 * @param {Function} [options.WebSocket] - WebSocket 构造函数（测试注入）
	 */
	constructor(options = {}) {
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

		// connId 管理
		/** @type {Map<string, string>} clawId → connId */
		this.__connIds = new Map();
		/** @type {Map<string, string>} connId → clawId（反向索引） */
		this.__connIdToClawId = new Map();

		// 事件监听
		this.__listeners = new Map();

		// 前台恢复
		this.__boundVisibilityHandler = null;
		this.__boundForegroundHandler = null;
		this.__boundNetworkHandler = null;
		this.__lastForegroundAt = 0;

		// 连接感知
		this.__lastAliveAt = 0;
		this.__probeTimer = null;
		/** @type {number} 上次 verify 成功的时间戳 */
		this.__lastVerifiedAt = 0;
	}

	/** @returns {'disconnected' | 'connecting' | 'connected'} */
	get state() {
		return this.__state;
	}

	/** @returns {number} 最后一次确认连接存活的时间戳 */
	get lastAliveAt() {
		return this.__lastAliveAt;
	}

	// --- 公共 API ---

	/** 建立连接（幂等） */
	connect() {
		if (this.__ws) return;
		console.debug('[SigConn] connect');
		this.__intentionalClose = false;
		if (typeof document !== 'undefined' && !this.__boundVisibilityHandler) {
			this.__boundVisibilityHandler = () => this.__onVisibilityChange();
			document.addEventListener('visibilitychange', this.__boundVisibilityHandler);
		}
		if (typeof window !== 'undefined' && !this.__boundForegroundHandler) {
			this.__boundForegroundHandler = () => this.__onAppForeground();
			window.addEventListener('app:foreground', this.__boundForegroundHandler);
		}
		if (typeof window !== 'undefined' && !this.__boundNetworkHandler) {
			this.__boundNetworkHandler = () => this.__handleForegroundResume('network:online');
			window.addEventListener('network:online', this.__boundNetworkHandler);
		}
		this.__doConnect();
	}

	/**
	 * 确保信令 WS 已连接。
	 * @param {object} [opts]
	 * @param {boolean} [opts.verify=false] - true 时强制验证连接存活性（用于 RTC 恢复场景）
	 * @param {number} [opts.timeoutMs=15000] - 超时毫秒数
	 * @returns {Promise<void>} resolve = connected；reject = 超时或主动断开
	 */
	async ensureConnected({ verify = false, timeoutMs = 15_000 } = {}) {
		if (this.__intentionalClose) {
			throw new Error('SignalingConnection intentionally closed');
		}

		// verify 冷却：5s 内视同 verify=false
		if (verify && (Date.now() - this.__lastVerifiedAt < VERIFY_COOLDOWN_MS)) {
			verify = false;
		}

		if (this.__state === 'connected') {
			if (!verify) return;
			this.__lastVerifiedAt = Date.now();
			// WS 最近有活动 → 信任其存活性，不 forceReconnect
			const elapsed = Date.now() - this.__lastAliveAt;
			if (elapsed <= PROBE_TIMEOUT_MS) return;
			// WS 疑似僵死 → forceReconnect
			this.forceReconnect();
			await this.__waitForConnected(timeoutMs);
			return;
		}

		if (this.__state === 'connecting') {
			await this.__waitForConnected(timeoutMs);
			if (verify) this.__lastVerifiedAt = Date.now();
			return;
		}

		// disconnected → 立即触发连接
		this.__clearReconnect();
		this.__reconnectDelay = INITIAL_RECONNECT_MS;
		this.__doConnect();
		await this.__waitForConnected(timeoutMs);
		if (verify) this.__lastVerifiedAt = Date.now();
	}

	/** 主动断开，不再自动重连 */
	disconnect() {
		console.debug('[SigConn] disconnect');
		this.__intentionalClose = true;
		this.__clearReconnect();
		this.__cleanup();
		this.__setState('disconnected');
	}

	/**
	 * 获取或创建某 claw 的 connId
	 * @param {string} clawId
	 * @returns {string}
	 */
	getOrCreateConnId(clawId) {
		const id = String(clawId);
		let connId = this.__connIds.get(id);
		if (!connId) {
			connId = `c_${crypto.randomUUID()}`;
			this.__connIds.set(id, connId);
			this.__connIdToClawId.set(connId, id);
		}
		return connId;
	}

	/**
	 * 释放某 claw 的 connId（claw 解绑/移除时调用）
	 * @param {string} clawId
	 */
	releaseConnId(clawId) {
		const id = String(clawId);
		const connId = this.__connIds.get(id);
		if (!connId) return;
		console.debug('[SigConn] releaseConnId clawId=%s connId=%s', id, connId);
		// 尝试通知 server 释放路由（best-effort）
		this.__sendRaw({ type: 'rtc:closed', clawId: id, connId });
		this.__connIds.delete(id);
		this.__connIdToClawId.delete(connId);
	}

	/**
	 * 发送 RTC 信令
	 * @param {string} clawId
	 * @param {string} type - 消息类型（如 'rtc:offer'）
	 * @param {object} [payload] - 信令载荷
	 * @returns {boolean} 是否发送成功（false 表示 WS 不可用）
	 */
	sendSignaling(clawId, type, payload) {
		const connId = this.getOrCreateConnId(clawId);
		const msg = { type, clawId: String(clawId), connId };
		if (payload !== undefined) msg.payload = payload;
		return this.__sendRaw(msg);
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
			catch (e) { console.error('[SigConn] listener error:', e); }
		}
	}

	__setState(newState) {
		if (this.__state === newState) return;
		const prev = this.__state;
		this.__state = newState;
		console.debug('[SigConn] state %s→%s', prev, newState);
		this.__emit('log', `sig.state ${prev}→${newState}`);
		this.__emit('state', newState);
	}

	/**
	 * @param {object} payload
	 * @returns {boolean}
	 */
	__sendRaw(payload) {
		if (!this.__ws || this.__ws.readyState !== 1) return false;
		try {
			this.__ws.send(JSON.stringify(payload));
			return true;
		}
		catch (err) {
			console.warn('[SigConn] sendRaw failed: %s', err?.message);
			return false;
		}
	}

	__doConnect() {
		this.__setState('connecting');
		const wsUrl = resolveSignalingWsUrl(this.__baseUrl);
		let ws;
		try {
			ws = new this.__WS(wsUrl);
		}
		catch (err) {
			console.warn('[SigConn] WS constructor failed: %s', err?.message);
			this.__setState('disconnected');
			this.__scheduleReconnect();
			return;
		}
		this.__ws = ws;

		ws.addEventListener('open', () => {
			if (this.__ws !== ws) return;
			console.debug('[SigConn] ws open');
			this.__setState('connected');
			this.__lastVerifiedAt = Date.now();
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
			console.debug('[SigConn] ws close code=%d reason=%s', ev.code, ev.reason);
			this.__emit('log', `sig.close code=${ev.code} reason=${ev.reason || 'none'}`);
			this.__clearHeartbeat();
			this.__clearProbe();
			this.__ws = null;
			if (!this.__intentionalClose) {
				this.__setState('disconnected');
				this.__scheduleReconnect();
			}
		});

		ws.addEventListener('error', () => {
			console.debug('[SigConn] ws error');
		});
	}

	__onMessage(event) {
		let payload;
		try {
			payload = JSON.parse(String(event.data ?? '{}'));
		}
		catch (err) {
			console.warn('[SigConn] message parse failed: %s', err?.message);
			return;
		}

		if (payload?.type === 'pong') return;

		// 入站 RTC 信令：rtc:answer / rtc:ice / rtc:closed
		if (payload?.type?.startsWith('rtc:')) {
			const connId = payload.toConnId;
			const clawId = connId ? this.__connIdToClawId.get(connId) : null;
			if (!clawId) {
				console.warn('[SigConn] rtc msg for unknown connId=%s type=%s', connId, payload.type);
				return;
			}
			// server 端关闭通知 → 清理本地 connId 映射
			if (payload.type === 'rtc:closed') {
				console.debug('[SigConn] rtc:closed received for clawId=%s connId=%s', clawId, connId);
				this.__connIds.delete(clawId);
				this.__connIdToClawId.delete(connId);
			}
			this.__emit('rtc', {
				clawId,
				type: payload.type,
				payload: payload.payload,
			});
			return;
		}

		// 未识别消息
		console.debug('[SigConn] unknown msg type=%s', payload?.type);
	}

	// --- 心跳 ---

	__startHeartbeat() {
		this.__clearHeartbeat();
		this.__hbMissCount = 0;
		this.__hbInterval = setInterval(() => {
			if (this.__ws?.readyState === 1) {
				try { this.__ws.send(JSON.stringify({ type: 'ping' })); }
				catch (err) { console.debug('[SigConn] ping send failed: %s', err?.message); }
			}
		}, HB_PING_MS);
		this.__resetHbTimeout();
	}

	__resetHbTimeout() {
		this.__hbMissCount = 0;
		this.__lastAliveAt = Date.now();
		if (this.__hbTimer) clearTimeout(this.__hbTimer);
		this.__hbTimer = setTimeout(() => this.__onHbMiss(), HB_TIMEOUT_MS);
	}

	__onHbMiss() {
		this.__hbMissCount++;
		console.debug('[SigConn] hb miss %d/%d', this.__hbMissCount, HB_MAX_MISS);
		if (this.__hbMissCount >= HB_MAX_MISS) {
			console.warn('[SigConn] hb max miss → closing WS');
			this.__emit('log', `sig.hbTimeout miss=${this.__hbMissCount}`);
			const ws = this.__ws;
			this.__ws = null;
			this.__clearHeartbeat();
			if (ws) {
				try { ws.close(4001, 'heartbeat_timeout'); } catch (err) { console.debug('[SigConn] ws.close failed: %s', err?.message); }
			}
			if (!this.__intentionalClose) {
				this.__setState('disconnected');
				this.__scheduleReconnect();
			}
		} else {
			// 再发一次 ping 并重置 timeout
			if (this.__ws?.readyState === 1) {
				try { this.__ws.send(JSON.stringify({ type: 'ping' })); } catch (err) { console.debug('[SigConn] ping send failed: %s', err?.message); }
			}
			this.__hbTimer = setTimeout(() => this.__onHbMiss(), HB_TIMEOUT_MS);
		}
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
		console.debug('[SigConn] reconnect in %dms', Math.round(delay));
		this.__emit('log', `sig.reconnect delay=${Math.round(delay)}ms`);
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

	// --- Visibility / Foreground 恢复 ---

	__onVisibilityChange() {
		if (typeof document === 'undefined') return;
		if (document.visibilityState !== 'visible') return;
		this.__handleForegroundResume('visibility');
	}

	__onAppForeground() {
		this.__handleForegroundResume('app:foreground');
	}

	/**
	 * 前台恢复统一入口（visibilitychange / app:foreground / network:online 共用）
	 * WS 恢复全平台执行；foreground-resume 事件仅在移动端或 network:online 时发射
	 * @param {string} source - 触发来源
	 */
	__handleForegroundResume(source) {
		if (this.__intentionalClose) return;
		const isNetworkOnline = source === 'network:online';
		// 防重入节流：network:online 豁免（它是明确的网络变更信号，不应被前序事件抑制）
		// 连续 network:online 由 connecting 状态分支 + RTC _rtcInitInProgress 守卫自然防护
		const now = Date.now();
		if (!isNetworkOnline && now - this.__lastForegroundAt < FOREGROUND_THROTTLE_MS) return;
		this.__lastForegroundAt = now;

		// RTC 恢复事件仅对移动端 visibility/app:foreground 或全平台 network:online 有意义
		// 桌面 visibilitychange 不触发（WebRTC 在桌面后台持续运行）
		const shouldEmitForRtc = isNetworkOnline || isCapacitorApp;

		if (this.__state === 'disconnected') {
			console.debug('[SigConn] %s → immediate reconnect', source);
			this.__emit('log', `sig.resume source=${source} state=disconnected action=reconnect`);
			this.__clearReconnect();
			this.__reconnectDelay = INITIAL_RECONNECT_MS;
			this.__doConnect();
			if (shouldEmitForRtc) {
				this.__emit('foreground-resume', { source });
			}
			return;
		}

		if (this.__state === 'connecting') {
			// network:online 时仍需发射 RTC 恢复事件（WS 正在重连，但 DC 可能需要独立恢复）
			if (isNetworkOnline) {
				this.__emit('foreground-resume', { source });
			}
			return;
		}

		// state === 'connected'
		const elapsed = now - this.__lastAliveAt;

		if (isNetworkOnline) {
			// 网络切换后 IP 变化，旧 TCP 连接必死，无论 elapsed 多少都应重建
			console.debug('[SigConn] %s → forceReconnect (network change)', source);
			this.__emit('log', `sig.resume source=${source} elapsed=${elapsed}ms action=forceReconnect(network)`);
			this.forceReconnect();
		} else if (elapsed > ASSUME_DEAD_MS) {
			console.debug('[SigConn] %s → assume dead (elapsed=%dms)', source, elapsed);
			this.__emit('log', `sig.resume source=${source} elapsed=${elapsed}ms action=forceReconnect`);
			this.forceReconnect();
		} else if (this.__lastAliveAt > 0 && elapsed > PROBE_TIMEOUT_MS) {
			console.debug('[SigConn] %s → probe (elapsed=%dms)', source, elapsed);
			this.__emit('log', `sig.resume source=${source} elapsed=${elapsed}ms action=probe`);
			this.probe();
		}

		if (shouldEmitForRtc) {
			this.__emit('foreground-resume', { source });
		}
	}

	/** 探测连接存活性 */
	probe() {
		if (this.__probeTimer) return;
		if (!this.__ws || this.__ws.readyState !== 1) {
			this.forceReconnect();
			return;
		}
		const aliveAtBefore = this.__lastAliveAt;
		try { this.__ws.send(JSON.stringify({ type: 'ping' })); }
		catch (err) {
			console.debug('[SigConn] probe ping send failed: %s → forceReconnect', err?.message);
			this.forceReconnect();
			return;
		}

		this.__probeTimer = setTimeout(() => {
			this.__probeTimer = null;
			if (this.__lastAliveAt > aliveAtBefore) {
				console.debug('[SigConn] probe ok');
				return;
			}
			console.debug('[SigConn] probe timeout → forceReconnect');
			this.forceReconnect();
		}, PROBE_TIMEOUT_MS);
	}

	/** 强制重连 */
	forceReconnect() {
		if (this.__intentionalClose) return;
		console.debug('[SigConn] forceReconnect');
		this.__clearProbe();
		this.__clearHeartbeat();
		this.__clearReconnect();
		const ws = this.__ws;
		this.__ws = null;
		if (ws) {
			try { ws.close(4000, 'force_reconnect'); } catch (err) { console.debug('[SigConn] ws.close failed: %s', err?.message); }
		}
		this.__setState('disconnected');
		this.__reconnectDelay = INITIAL_RECONNECT_MS;
		this.__doConnect();
	}

	/**
	 * 等待状态变为 connected，超时则 reject。
	 * @param {number} timeoutMs
	 * @returns {Promise<void>}
	 */
	__waitForConnected(timeoutMs) {
		return new Promise((resolve, reject) => {
			if (this.__state === 'connected') { resolve(); return; }

			let timer = null;
			let handler = null;
			const cleanup = () => {
				if (timer) { clearTimeout(timer); timer = null; }
				if (handler) { this.off('state', handler); handler = null; }
			};
			handler = (s) => {
				if (s === 'connected') { cleanup(); resolve(); }
				// disconnect() 被调用 → 不会再变为 connected，立即 reject
				else if (this.__intentionalClose) { cleanup(); reject(new Error('SignalingConnection intentionally closed')); }
			};
			this.on('state', handler);
			timer = setTimeout(() => {
				cleanup();
				reject(new Error('ensureConnected timeout'));
			}, timeoutMs);
		});
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
		if (this.__boundNetworkHandler && typeof window !== 'undefined') {
			window.removeEventListener('network:online', this.__boundNetworkHandler);
			this.__boundNetworkHandler = null;
		}
		const ws = this.__ws;
		this.__ws = null;
		if (ws) {
			try { ws.close(1000, 'disconnect'); } catch (err) { console.debug('[SigConn] cleanup ws.close failed: %s', err?.message); }
		}
	}
}

// --- 单例 ---

let instance = null;

/**
 * 获取 SignalingConnection 单例
 * @param {object} [options] - 仅首次创建时生效
 * @returns {SignalingConnection}
 */
export function useSignalingConnection(options) {
	if (!instance) {
		instance = new SignalingConnection(options);
	}
	return instance;
}

/** @internal 仅供测试重置 */
export function __resetSignalingConnection() {
	if (instance) {
		instance.disconnect();
	}
	instance = null;
}
