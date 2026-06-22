/**
 * 单个 Claw 的数据通道连接
 * 职责：RPC over DataChannel、WebRtcConnection 引用管理、事件分发、连接就绪等待
 * 无 Vue 依赖，纯 JS
 *
 * WS 信令管理已迁移至 SignalingConnection（per-tab 单例）
 */
import { useSignalingConnection } from './signaling-connection.js';
import { remoteLog } from './remote-log.js';

/** 默认请求超时（发送后等待响应），0 表示永不超时 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** 默认连接等待超时（等待 DC 就绪）：覆盖一次 ICE restart 180s 预算 + 30s settled 余量。
 *  仅作用于 DC 尚未 open 的 waitReady；DC open 后（含 ICE restart 期间，DC 仍 open）走 fast-path
 *  立即 resolve，restart 期间发的 RPC 受各自 requestTimeout 约束，不再过 connectTimeout。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 210_000;
/** 短暂抖动 vs 实质断连分界（reconnect gap < 此值跳过 refresh，避免短抖动后无意义全量刷新） */
const BRIEF_DISCONNECT_MS = 30_000;

// 导出常量供外部模块使用
export { BRIEF_DISCONNECT_MS, DEFAULT_CONNECT_TIMEOUT_MS };

// 可选的 RPC trace：localStorage.rpcTrace='1' 时把入站/出站打到 console.debug。
// 模块加载时读一次缓存到 rpcTraceEnabled，热路径只读布尔变量，避免在
// agent run 流式入站事件高频段反复触发 localStorage 同步访问（Capacitor
// Android WebView 上尤其慢）。调试期改完 localStorage 后在 Console 调用
// __refreshRpcTrace() 即可生效，无需刷新页面。
const TRACE_PREFIX = '[rpc-trace]';
let rpcTraceEnabled = false;
function refreshRpcTrace() {
	try { rpcTraceEnabled = globalThis.localStorage?.getItem?.('rpcTrace') === '1'; }
	catch { rpcTraceEnabled = false; }
}
refreshRpcTrace();
if (typeof globalThis !== 'undefined') globalThis.__refreshRpcTrace = refreshRpcTrace;

/** 构造与 axios CanceledError 对齐的取消错误（err.name='CanceledError', err.code='ERR_CANCELED'） */
function makeAbortError() {
	const err = new Error('request aborted');
	err.name = 'CanceledError';
	err.code = 'ERR_CANCELED';
	return err;
}

/**
 * Per-claw 数据通道连接
 *
 * 事件:
 * - `event:<name>` — DataChannel 推送事件 (data: payload)
 */
export class ClawConnection {
	/**
	 * @param {string} clawId
	 */
	constructor(clawId) {
		this.clawId = String(clawId);

		// RPC pending
		this.__pending = new Map();
		this.__counter = 1;
		// 每个 ClawConnection 实例共用一个 uuid 前缀，保证跨连接 reqId 唯一，
		// 让插件端能按 reqId 把响应单播回发起方。详见 docs/designs/dc-rpc-response-unicast.md
		this.__uuid = crypto.randomUUID();

		// 事件监听
		this.__listeners = new Map();

		/** @type {import('./webrtc-connection.js').WebRtcConnection | null} */
		this.__rtc = null;

		// trace 时间基准
		this.__traceStartedAt = Date.now();

		// 连接就绪等待队列
		/** @type {{ resolve: Function, reject: Function, timer: number|null }[]} */
		this.__readyWaiters = [];

		/**
		 * 由外层（claws.store）注入的回调：触发 RTC 重连（fire-and-forget）
		 * @type {(() => void) | null}
		 */
		this.__onTriggerReconnect = null;

		/**
		 * 由外层（claws.store）注入的回调：获取当前 rtcPhase
		 * @type {(() => string) | null}
		 */
		this.__onGetRtcPhase = null;
	}

	/** @returns {import('./webrtc-connection.js').WebRtcConnection | null} */
	get rtc() { return this.__rtc; }

	/** 设置 RTC 连接引用，并 resolve 所有等待中的 waitReady */
	setRtc(rtcConn) {
		if (rtcConn && !rtcConn.isReady) {
			console.warn('[ClawConn] setRtc called with non-ready RTC, waiters may receive unusable connection');
		}
		this.__rtc = rtcConn;
		this.__resolveAllWaiters();
	}

	/** 清除 RTC 连接引用并 reject 所有挂起请求和等待（DC 已不可用） */
	clearRtc() {
		const pendingCount = this.__pending.size;
		const waiterCount = this.__readyWaiters.length;
		if (pendingCount || waiterCount) {
			remoteLog(`conn.clearRtc claw=${this.clawId} pending=${pendingCount} waiters=${waiterCount}`);
		}
		this.__rtc = null;
		this.__rejectAllWaiters('RTC connection lost', 'RTC_LOST');
		this.__rejectAllPending('RTC connection lost', 'RTC_LOST');
	}

	/** 断开：关闭 RTC + reject pending/waiters + 清事件监听 + 释放 connId */
	disconnect() {
		console.debug('[ClawConn] disconnect clawId=%s', this.clawId);
		if (this.__rtc) {
			try { this.__rtc.close(); } catch (err) { console.debug('[ClawConn] rtc.close() failed: %s', err?.message); }
			this.__rtc = null;
		}
		this.__rejectAllWaiters('connection closed', 'DC_CLOSED');
		this.__rejectAllPending('connection closed');
		// 主动切断 listener 闭包（chat.store 的 event:chat handler 持 store Proxy 引用）。
		// logout 顺序使得 chat.store.cleanup 里的 conn.off 拿到 null conn 跳过解绑，
		// 这里兜底清理避免依赖 ClawConnection 本身的 GC 时机。
		this.__listeners.clear();
		useSignalingConnection().releaseConnId(this.clawId);
	}

	/**
	 * 等待 DataChannel 就绪
	 * @param {number} [timeoutMs] - 超时 ms，默认 DEFAULT_CONNECT_TIMEOUT_MS
	 * @param {AbortSignal} [signal] - 可选取消信号；abort 优先于 fast-path（即使 DC 已 ready 也 reject）
	 * @returns {Promise<void>}
	 */
	waitReady(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, signal) {
		if (signal?.aborted) return Promise.reject(makeAbortError());
		if (this.__rtc?.isReady) return Promise.resolve();

		// 若 rtcPhase 为 failed（重试耗尽），主动触发重连
		const phase = this.__onGetRtcPhase?.();
		if (phase === 'failed') {
			this.__onTriggerReconnect?.();
		}

		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, timer: null, signal: null, onAbort: null };
			waiter.timer = setTimeout(() => {
				this.__removeWaiter(waiter);
				const err = new Error('connect timeout');
				err.code = 'CONNECT_TIMEOUT';
				remoteLog(`conn.waitReady.timeout claw=${this.clawId} timeout=${timeoutMs}ms phase=${this.__onGetRtcPhase?.() ?? '?'}`);
				reject(err);
			}, timeoutMs);
			if (signal) {
				waiter.signal = signal;
				waiter.onAbort = () => {
					this.__removeWaiter(waiter);
					reject(makeAbortError());
				};
				signal.addEventListener('abort', waiter.onAbort, { once: true });
			}
			this.__readyWaiters.push(waiter);
		});
	}

	/**
	 * 发送 RPC 请求（自动等待连接就绪）
	 * @param {string} method
	 * @param {object} [params]
	 * @param {object} [options]
	 * @param {(payload: object) => void} [options.onAccepted] - 两阶段模式回调
	 * @param {number} [options.timeout] - 请求超时 ms（0 = 永不超时），默认 30s
	 * @param {number} [options.connectTimeout] - 连接等待超时 ms，默认 DEFAULT_CONNECT_TIMEOUT_MS
	 * @param {string[]} [options.quietCodes] - 调用方可容忍的失败 code 列表；命中时不发 rpc.failed 远程诊断（reject 行为不变）
	 * @param {AbortSignal} [options.signal] - 可选取消信号，覆盖 waitReady 排队 + pending 两段；abort → reject ERR_CANCELED
	 * @returns {Promise<object>}
	 */
	request(method, params = {}, options = {}) {
		const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const signal = options.signal;

		if (signal?.aborted) return Promise.reject(makeAbortError());

		const doSend = () => {
			// waitReady → setRtc → doSend 是同步 resolve + 微任务两段。若同 sync 段或更早的微任务
			// 先 clearRtc，到 doSend 时 __rtc 已是 null，下面 send 会抛 TypeError 逃出 .then 链
			// 成为非 RTC_LOST 的 unmapped rejection。提前重核一次，与 clearRtc 路径同形式 reject。
			if (!this.__rtc?.isReady) {
				const err = new Error('RTC connection lost');
				err.code = 'RTC_LOST';
				return Promise.reject(err);
			}
			const id = `ui-${this.__uuid}-${this.__counter++}`;
			return new Promise((resolve, reject) => {
				const waiter = { resolve, reject, signal: null, onAbort: null, method };
				if (options.onAccepted) waiter.onAccepted = options.onAccepted;
				if (options.quietCodes) waiter.quietCodes = options.quietCodes;
				const timeoutMs = options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
				if (timeoutMs > 0) {
					waiter.timer = setTimeout(() => {
						if (!this.__pending.has(id)) return;
						this.__pending.delete(id);
						this.__cleanupWaiter(waiter);
						const err = new Error('rpc timeout');
						err.code = 'RPC_TIMEOUT';
						remoteLog(`rpc.timeout claw=${this.clawId} method=${method} timeout=${timeoutMs}ms`);
						reject(err);
					}, timeoutMs);
				}
				// 发送前在 pending 阶段再次检查 signal（可能在 waitReady 与 doSend 之间被 abort）
				if (signal?.aborted) {
					if (waiter.timer) clearTimeout(waiter.timer);
					reject(makeAbortError());
					return;
				}
				if (signal) {
					waiter.signal = signal;
					waiter.onAbort = () => {
						if (!this.__pending.has(id)) return;
						this.__pending.delete(id);
						this.__cleanupWaiter(waiter);
						reject(makeAbortError());
					};
					signal.addEventListener('abort', waiter.onAbort, { once: true });
				}
				this.__pending.set(id, waiter);
				const wireReq = { type: 'req', id, method, params };
				if (rpcTraceEnabled) {
					try {
						const rel = Date.now() - this.__traceStartedAt;
						const bytes = JSON.stringify(wireReq).length;
						console.debug(`${TRACE_PREFIX} +${rel}ms OUT req ${method} id=${id} bytes=${bytes}`);
					}
					catch {
						// trace 是诊断辅助，序列化或 console 调用异常都不应阻断真实发送流程。
					}
				}
				this.__rtc.send(wireReq)
					.catch((sendErr) => {
						if (!this.__pending.has(id)) return;
						this.__pending.delete(id);
						this.__cleanupWaiter(waiter);
						const err = new Error('rtc send failed');
						err.code = 'RTC_SEND_FAILED';
						remoteLog(`rpc.sendFailed claw=${this.clawId} method=${method} err=${sendErr?.message}`);
						reject(err);
					});
			});
		};

		// abort 优先级高于 fast-path：即使 DC 已 ready 也要尊重已 abort 的 signal（上方已处理）
		if (this.__rtc?.isReady) return doSend();
		return this.waitReady(connectTimeout, signal).then(doSend);
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
			catch (e) { console.error('[ClawConn] listener error:', e); }
		}
	}

	/** DataChannel 消息处理（由 WebRtcConnection 回调） */
	__onRtcMessage(payload) {
		if (rpcTraceEnabled) {
			try {
				const rel = Date.now() - this.__traceStartedAt;
				let bytes = 0;
				try { bytes = JSON.stringify(payload).length; } catch {}
				if (payload.type === 'res' && payload.id) {
					// 注意：此时 pending 还未删除（删除发生在下面 __handleRpcResponse 内），
					// 所以这里能拿到当初发送时记录的 method。
					const method = this.__pending.get(payload.id)?.method ?? '?';
					const status = payload?.payload?.status ?? '-';
					console.debug(`${TRACE_PREFIX} +${rel}ms IN  res ${method} id=${payload.id} ok=${payload.ok} status=${status} bytes=${bytes}`);
				} else if (payload.type === 'event' && payload.event) {
					console.debug(`${TRACE_PREFIX} +${rel}ms IN  event ${payload.event} bytes=${bytes}`);
				}
			}
			catch {
				// trace 块的任何异常都不应阻断 __handleRpcResponse / __handleEvent 调用。
			}
		}
		if (payload.type === 'res' && payload.id) {
			this.__handleRpcResponse(payload);
		} else if (payload.type === 'event' && payload.event) {
			this.__emit(`event:${payload.event}`, payload.payload);
		}
	}

	__handleRpcResponse(payload) {
		const waiter = this.__pending.get(payload.id);
		if (!waiter) {
			console.warn('[ClawConn] unmatched rpc response id=%s ok=%s clawId=%s', payload.id, payload.ok, this.clawId);
			return;
		}

		// 失败：立即 reject
		if (payload.ok === false) {
			this.__pending.delete(payload.id);
			this.__cleanupWaiter(waiter);
			const err = new Error(payload?.error?.message ?? 'rpc failed');
			err.code = payload?.error?.code ?? 'RPC_FAILED';
			// 调用方声明可容忍的 code(如 silent 加载的 NOT_FOUND)不上报远程诊断噪音
			if (!waiter.quietCodes?.includes(err.code)) {
				remoteLog(`rpc.failed claw=${this.clawId} code=${err.code} err=${err.message}`);
			}
			waiter.reject(err);
			return;
		}

		const status = payload.payload?.status;

		// 两阶段中间态：仅 status === 'accepted' 表示"还有后续帧跟随"。
		// 与上游 gateway/client.ts 的 `expectFinal && status === "accepted"` 严格镜像，
		// 也与 plugin 端 isFinalResMsg 保持一致（见 docs/designs/dc-rpc-response-unicast.md §5.1）。
		if (waiter.onAccepted && status === 'accepted') {
			// 协议保证每个 reqId 只发 1 次 accepted。重复 accepted 不应发生；
			// 兜底吞掉避免重复副作用（刷新时间戳 / 覆盖 watcher 等），同时上报便于感知上游行为变更
			if (waiter.__acceptedSeen) {
				console.warn('[ClawConn] duplicate accepted res ignored id=%s clawId=%s method=%s', payload.id, this.clawId, waiter.method ?? '?');
				remoteLog(`rpc.accepted.duplicate claw=${this.clawId} method=${waiter.method ?? '?'} reqId=${payload.id}`);
				return;
			}
			waiter.__acceptedSeen = true;
			waiter.onAccepted(payload.payload);
			return;
		}

		// 其余 ok=true 一律视为终态：
		// - 单阶段（无 onAccepted）：任何 ok=true 即终态
		// - 两阶段：除 accepted 外的任何 status（'ok' / 'error' / 'timeout' /
		//   上游未来新增的任何字符串）都不会再有后续帧，提前清条目并 resolve 透传
		// 下列读类 method（chat.history / sessions.* / agents.list / coclaw.*）的调用点刻意不防御
		// ok:true + payload.status='error'：已逐个核对上游 handler——它们的成功 payload 不带顶层 status
		// 字段，失败走帧级 ok:false（上方已 reject）；个别如 coclaw.topics.delete 的"未找到"走载荷内业务
		// ok:false、由调用点自行 throw（topics.store.js），那是 ok 字段而非 status，仍非本组合。故该组合
		// 不可达；即便触发，各调用点最坏也只是视图清空/乐观值，重拉即自恢复。
		// 注意：chat.send 是另一类单阶段 method，确实回传顶层 status，已在其调用点单独读取处理（见
		// chat.store.js 的 slash-command 分支），不在上述"不带 status"之列；若未来某读类 method 新增
		// 顶层 status 字段，需重审其调用点。
		this.__pending.delete(payload.id);
		this.__cleanupWaiter(waiter);
		waiter.resolve(payload.payload ?? {});
	}

	/** 清理 waiter 上的 timer 和 abort listener（resolve/reject 任一出口调用） */
	__cleanupWaiter(waiter) {
		if (waiter.timer) clearTimeout(waiter.timer);
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener('abort', waiter.onAbort);
		}
	}

	__rejectAllPending(message, code = 'DC_CLOSED') {
		if (this.__pending.size) {
			remoteLog(`conn.rejectPending claw=${this.clawId} count=${this.__pending.size} code=${code}`);
			// 逐条记录被 reject 的请求 method + reqId，定位"哪条 sendMessage 链路被这次 DC close 打断"
			for (const [reqId, waiter] of this.__pending) {
				remoteLog(`conn.rejectPending.detail claw=${this.clawId} method=${waiter.method ?? '?'} reqId=${reqId}`);
			}
		}
		for (const waiter of this.__pending.values()) {
			this.__cleanupWaiter(waiter);
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
			this.__cleanupWaiter(w);
			w.resolve();
		}
	}

	/** reject 并清空所有 readyWaiters */
	__rejectAllWaiters(message, code) {
		const waiters = this.__readyWaiters.splice(0);
		for (const w of waiters) {
			this.__cleanupWaiter(w);
			const err = new Error(message);
			err.code = code;
			w.reject(err);
		}
	}

	/** 从 readyWaiters 中移除指定 waiter（同时清理 timer 和 abort listener） */
	__removeWaiter(waiter) {
		const idx = this.__readyWaiters.indexOf(waiter);
		if (idx !== -1) this.__readyWaiters.splice(idx, 1);
		this.__cleanupWaiter(waiter);
	}
}
