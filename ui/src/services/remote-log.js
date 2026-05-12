/**
 * 远程日志推送服务（per-tab 单例）
 *
 * 通过独立 HTTP 短连接 POST /api/v1/log/ui 把诊断日志批量送达 CoClaw server。
 * 与 RTC signaling WS 生命周期解耦，弱网/重建窗口下仍可独立工作。
 *
 * 设计文档：docs/designs/ui-remote-log-http-channel.md
 */
import axios from 'axios';
import { nanoid } from 'nanoid';

import { resolveApiBaseUrl } from './http.js';
import { useSignalingConnection } from './signaling-connection.js';

/** 单个 batch 内 log 条数上限，亦为大小触发阈值（≥ 阈值立刻封批）。*/
export const BATCH_SIZE = 100;
/** Debounce 时间阈值；距上次封批超过此值即使未攒够也封批。*/
export const DEBOUNCE_MS = 5000;
/** 未封批 ring buffer 上限；溢出丢最旧 entry。*/
export const MAX_RING = 1000;
/** 已封批待发队列上限；溢出丢最旧整批。*/
export const MAX_PENDING = 10;
/** 单 batch 重试次数上限。*/
export const MAX_ATTEMPTS = 8;
/** 单 batch 从首次发起到放弃的总时长上限。*/
export const MAX_DURATION_MS = 10 * 60 * 1000;
/** 指数退避基数。*/
export const BACKOFF_BASE_MS = 1000;
/** 指数退避上限。*/
export const BACKOFF_CAP_MS = 60 * 1000;
/** uiId 字符长度（nanoid 默认）。*/
export const UI_ID_LENGTH = 21;
/** HTTP 发送超时（ms）。*/
export const HTTP_TIMEOUT_MS = 30_000;
/** 端点路径。*/
export const ENDPOINT_PATH = '/api/v1/log/ui';

/**
 * @typedef {{
 *   kind: 'success'
 *       | 'badRequest'
 *       | 'retryable'
 *       | 'network',
 *   retryAfterMs?: number,
 *   error?: Error,
 * }} SendResult
 */

/**
 * @typedef {{
 *   uiId: string,
 *   seq: number,
 *   logs: { ts: number, text: string }[],
 *   attempts: number,
 *   firstAttemptAt: number,
 * }} PendingBatch
 */

export class RemoteLog {
	/**
	 * @param {Object} opts
	 * @param {(payload: { uiId: string, seq: number, logs: { ts: number, text: string }[] }) => Promise<SendResult>} opts.send - 发送一个 batch；返回归一化结果
	 * @param {string} [opts.uiId] - 注入 uiId（仅测试）
	 * @param {() => number} [opts.now] - 时间源（仅测试）
	 * @param {() => number} [opts.random] - 抖动源（仅测试）
	 */
	constructor(opts) {
		if (!opts || typeof opts.send !== 'function') {
			throw new Error('RemoteLog: opts.send is required');
		}
		this.__send = opts.send;
		this.uiId = opts.uiId || nanoid(UI_ID_LENGTH);
		this.__now = opts.now || (() => Date.now());
		this.__random = opts.random || Math.random;

		this.__seq = 0;
		/** @type {{ ts: number, text: string }[]} */
		this.__ring = [];
		/** @type {PendingBatch[]} */
		this.__pending = [];
		/** @type {PendingBatch | null} */
		this.__inFlight = null;
		this.__debounceTimer = null;
		this.__retryTimer = null;
		this.__stopped = false;
		/** @type {{ conn: any, fn: (text: string) => void } | null} */
		this.__sigBridge = null;
	}

	/**
	 * 桥接 SignalingConnection 的 'log' 事件到 remote-log。stop() 时会 off 掉，避免跨 reset 泄漏。
	 * @param {{ on: Function, off: Function }} sigConn
	 */
	attachSigBridge(sigConn) {
		if (this.__sigBridge) return;
		const fn = (text) => { if (!this.__stopped) this.log(text); };
		sigConn.on('log', fn);
		this.__sigBridge = { conn: sigConn, fn };
	}

	/**
	 * 推送一条日志：进 ring buffer，触发条件满足即封批/发送。
	 * @param {string} text
	 */
	log(text) {
		if (this.__stopped) return;
		this.__ring.push({ ts: this.__now(), text });
		if (this.__ring.length > MAX_RING) this.__ring.shift();
		if (this.__ring.length >= BATCH_SIZE) {
			this.__pack();
			return;
		}
		if (!this.__debounceTimer) {
			this.__debounceTimer = setTimeout(() => {
				this.__debounceTimer = null;
				this.__pack();
			}, DEBOUNCE_MS);
		}
	}

	/** 把 ring buffer 全部封批入待发队列，触发 pump。*/
	__pack() {
		if (this.__debounceTimer) {
			clearTimeout(this.__debounceTimer);
			this.__debounceTimer = null;
		}
		if (this.__ring.length === 0) {
			this.__pump();
			return;
		}
		while (this.__ring.length > 0) {
			const logs = this.__ring.splice(0, BATCH_SIZE);
			this.__seq += 1;
			this.__pending.push({
				uiId: this.uiId,
				seq: this.__seq,
				logs,
				attempts: 0,
				firstAttemptAt: 0,
			});
			while (this.__pending.length > MAX_PENDING) {
				this.__pending.shift();
			}
		}
		this.__pump();
	}

	/** 若空闲则取队列头开始发送。*/
	__pump() {
		if (this.__stopped) return;
		if (this.__inFlight) return;
		if (this.__retryTimer) return;
		const batch = this.__pending.shift();
		if (!batch) return;
		this.__inFlight = batch;
		this.__attempt();
	}

	/** 对 inFlight 发起一次（首次或重试）。*/
	__attempt() {
		if (this.__stopped) return;
		const batch = this.__inFlight;
		if (!batch) return;
		batch.attempts += 1;
		if (!batch.firstAttemptAt) batch.firstAttemptAt = this.__now();
		const payload = { uiId: batch.uiId, seq: batch.seq, logs: batch.logs };
		Promise.resolve()
			.then(() => this.__send(payload))
			.then((res) => this.__onResult(batch, res || { kind: 'network' }))
			.catch((err) => this.__onResult(batch, { kind: 'network', error: err }));
	}

	__onResult(batch, res) {
		// stop() 后到达的迟到响应直接丢弃，避免再调度新的 retry timer
		if (this.__stopped) return;
		// 异步回调可能在已被丢弃的 batch 上回来：忽略
		if (this.__inFlight !== batch) return;
		switch (res.kind) {
			case 'success':
			case 'badRequest':
				this.__inFlight = null;
				this.__pump();
				return;
			case 'retryable':
			case 'network': {
				const elapsed = this.__now() - batch.firstAttemptAt;
				if (batch.attempts >= MAX_ATTEMPTS || elapsed >= MAX_DURATION_MS) {
					this.__inFlight = null;
					this.__pump();
					return;
				}
				const delay = this.__computeBackoff(batch.attempts, res.retryAfterMs);
				this.__retryTimer = setTimeout(() => {
					this.__retryTimer = null;
					this.__attempt();
				}, delay);
				return;
			}
			default:
				// 未知种类视为网络错误，走退避
				this.__onResult(batch, { kind: 'network' });
		}
	}

	__computeBackoff(attempt, retryAfterMs) {
		// 服务端可能给出 0 表示"立即重试"，需保留这个意图；负数/NaN 才回退到指数退避
		if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
			return Math.min(retryAfterMs, BACKOFF_CAP_MS);
		}
		const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
		const jitter = base * 0.2 * this.__random();
		return Math.floor(base + jitter);
	}

	/**
	 * 立即封批并推动发送循环。供调用方在需要确定性收尾的场景使用（如单测）。
	 * 不影响重试 backoff 状态。
	 */
	flush() {
		this.__pack();
	}

	/**
	 * 停止后续发送 / 定时器，并解绑 sigConn 桥接监听器。
	 * 注意：已经在飞的 send Promise 仍会 resolve / reject，但 __onResult 入口的 __stopped 守卫
	 * 会丢弃迟到响应，不会再调度新的 retry。
	 */
	stop() {
		this.__stopped = true;
		if (this.__debounceTimer) clearTimeout(this.__debounceTimer);
		if (this.__retryTimer) clearTimeout(this.__retryTimer);
		this.__debounceTimer = null;
		this.__retryTimer = null;
		this.__inFlight = null;
		if (this.__sigBridge) {
			try { this.__sigBridge.conn.off('log', this.__sigBridge.fn); } catch (err) {
				console.warn('[remote-log] sigConn.off failed:', err?.message);
			}
			this.__sigBridge = null;
		}
	}
}

// --- HTTP 发送适配器 ---

/**
 * 把 axios 响应/异常归一化为 SendResult
 * @param {import('axios').AxiosInstance} http
 * @param {{ uiId: string, seq: number, logs: { ts: number, text: string }[] }} payload
 * @returns {Promise<SendResult>}
 */
export async function httpSender(http, payload) {
	try {
		await http.post(ENDPOINT_PATH, payload, { timeout: HTTP_TIMEOUT_MS });
		return { kind: 'success' };
	} catch (err) {
		const status = err?.response?.status;
		const headers = err?.response?.headers;
		if (status === 408 || status === 429) {
			return { kind: 'retryable', retryAfterMs: parseRetryAfter(headers?.['retry-after']) };
		}
		if (typeof status === 'number' && status >= 500 && status < 600) {
			return { kind: 'retryable' };
		}
		if (typeof status === 'number' && status >= 400 && status < 500) {
			return { kind: 'badRequest' };
		}
		return { kind: 'network', error: err };
	}
}

function parseRetryAfter(v) {
	if (v === undefined || v === null || v === '') return undefined;
	const n = Number(v);
	if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000);
	const t = Date.parse(v);
	if (Number.isFinite(t)) return Math.max(0, t - Date.now());
	return undefined;
}

// --- ui.start 环境采集 ---

/**
 * 构造 ui.start 首条 log 文本。可选字段取不到时整字段省略。
 * @param {string} uiId
 * @returns {string}
 */
export function buildUiStartText(uiId) {
	const parts = [`uiId=${uiId}`];
	const version = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || 'unknown';
	parts.push(`version=${version}`);
	parts.push(`platform=${detectPlatformLabel()}`);
	if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') {
		const dpr = window.devicePixelRatio || 1;
		parts.push(`viewport=${window.innerWidth}x${window.innerHeight}@${dpr}`);
	}
	if (typeof navigator !== 'undefined') {
		const touch = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0;
		parts.push(`touch=${touch ? 'yes' : 'no'}`);
	}
	parts.push(`theme=${detectTheme()}`);
	if (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)) {
		parts.push(`cores=${navigator.hardwareConcurrency}`);
	}
	if (typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory)) {
		parts.push(`mem=${navigator.deviceMemory}`);
	}
	const tz = tryDetectTimeZone();
	if (tz) parts.push(`tz=${tz}`);
	if (typeof navigator !== 'undefined' && navigator.language) {
		parts.push(`lang=${navigator.language}`);
	}
	const net = navigator?.connection?.effectiveType;
	if (net) parts.push(`net=${net}`);
	if (typeof navigator !== 'undefined' && navigator.userAgent) {
		parts.push(`ua="${navigator.userAgent}"`);
	}
	return `ui.start ${parts.join(' ')}`;
}

function tryDetectTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
	} catch {
		return '';
	}
}

function detectPlatformLabel() {
	const Cap = typeof globalThis !== 'undefined' ? globalThis.Capacitor : undefined;
	if (Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform()) {
		const p = typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : '';
		if (p === 'android') return 'cap-android';
		if (p === 'ios') return 'cap-ios';
		return `cap-${p || 'unknown'}`;
	}
	const isElectron = !!(typeof globalThis !== 'undefined' && globalThis.electronAPI);
	if (isElectron) return detectElectronOsLabel();
	return 'web';
}

function detectElectronOsLabel() {
	const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
	if (/Windows/i.test(ua)) return 'electron-win';
	if (/Mac OS X|Macintosh/i.test(ua)) return 'electron-mac';
	if (/Linux/i.test(ua)) return 'electron-linux';
	return 'electron';
}

function detectTheme() {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'no-pref';
	try {
		if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
		if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
	} catch {
		return 'no-pref';
	}
	return 'no-pref';
}

// --- 单例 ---

let __instance = null;
let __dedicatedClient = null;

/**
 * 给 remote-log 通道用的独立 axios 实例，**不复用** `./http.js` 的 httpClient——
 * 后者带 401 → `auth:session-expired` 派发逻辑，会把"日志通道偶然返回 401"误升级为用户登出。
 * 设计要求日志通道与 auth 解耦（详见 docs/designs/ui-remote-log-http-channel.md §3.6 / §4.1）。
 */
function getDedicatedClient() {
	if (__dedicatedClient) return __dedicatedClient;
	__dedicatedClient = axios.create({
		baseURL: resolveApiBaseUrl(),
		withCredentials: true,  // cookie 用于服务端身份标注（user vs anon）
	});
	return __dedicatedClient;
}

/**
 * 获取 RemoteLog 单例。首次调用时初始化：生成 uiId / 入队 ui.start / 桥接 sigConn 的 log 事件。
 *
 * 端点不强制登录态，UI 实例发送行为与登录态完全解耦——不挂任何 login/logout flush hook、
 * 不 watch authStore；登录前 / 登录失败窗口的 log 同样能上送 server。
 *
 * @param {Object} [opts]
 * @param {(payload: { uiId: string, seq: number, logs: { ts: number, text: string }[] }) => Promise<SendResult>} [opts.send] - 发送函数（测试注入）
 * @param {string} [opts.uiId] - 注入 uiId（测试用）
 * @param {boolean} [opts.skipUiStart] - 跳过 ui.start 首条（测试用）
 * @param {boolean} [opts.skipSigBridge] - 跳过 signaling-connection 桥接（测试用）
 * @returns {RemoteLog}
 */
export function useRemoteLog(opts = {}) {
	if (__instance) return __instance;
	const send = opts.send || ((payload) => httpSender(getDedicatedClient(), payload));
	__instance = new RemoteLog({
		send,
		uiId: opts.uiId,
	});
	if (opts.skipUiStart !== true) {
		try {
			__instance.log(buildUiStartText(__instance.uiId));
		} catch (err) {
			console.warn('[remote-log] ui.start build failed:', err?.message);
		}
	}
	if (opts.skipSigBridge !== true) {
		try {
			const sigConn = useSignalingConnection();
			__instance.attachSigBridge(sigConn);
		} catch (err) {
			// signaling-connection 未就绪（如某些测试环境）时静默跳过
			console.warn('[remote-log] sigConn bridge skipped:', err?.message);
		}
	}
	return __instance;
}

/**
 * 便捷函数：推送一条远程诊断日志。首次调用自动初始化单例。
 * @param {string} text
 */
export function remoteLog(text) {
	useRemoteLog().log(text);
}

/** @internal 仅供测试重置 */
export function __resetRemoteLog() {
	if (__instance) {
		__instance.stop();
	}
	__instance = null;
}
