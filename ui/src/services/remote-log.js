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

import { sleep } from '../utils/async-utils.js';
import { resolveApiBaseUrl } from './http.js';
import { useSignalingConnection } from './signaling-connection.js';

/** 单个 batch 内 log 条数上限，亦为大小触发阈值（≥ 阈值立刻封批）。*/
export const BATCH_SIZE = 100;
/** Debounce 时间阈值；距上次封批超过此值即使未攒够也封批。*/
export const DEBOUNCE = 5000;
/** 未封批 ring buffer 上限；溢出丢最旧 entry。*/
export const MAX_RING = 1000;
/** 已封批待发队列上限；溢出丢最旧整批。*/
export const MAX_PENDING = 10;
/** uiId 字符长度（nanoid 默认）。*/
export const UI_ID_LENGTH = 21;
/** HTTP 发送超时。*/
export const HTTP_TIMEOUT = 30_000;
/** 端点路径。*/
export const ENDPOINT_PATH = '/api/v1/log/ui';

/**
 * 单 batch 重试时间表：失败后 sleep 对应项再发；首发 + length 次重试 = length + 1 次发送。
 * 数组作为唯一数据源——重试次数 = length，间隔 = 数组项；改一处即可。
 * 同时也是 Retry-After 的上限（防 server 给超长值）。
 */
export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

const RETRY_AFTER_CAP = Math.max(...RETRY_DELAYS);

/**
 * @typedef {{
 *   kind: 'success'
 *       | 'badRequest'
 *       | 'retryable'
 *       | 'network',
 *   retryAfter?: number,
 *   error?: Error,
 * }} SendResult
 */

/**
 * @typedef {{
 *   uiId: string,
 *   seq: number,
 *   logs: { ts: number, text: string }[],
 * }} PendingBatch
 */

export class RemoteLog {
	/**
	 * @param {Object} opts
	 * @param {(payload: { uiId: string, seq: number, logs: { ts: number, text: string }[] }, signal: AbortSignal) => Promise<SendResult>} opts.send - 发送一个 batch；接收 AbortSignal，返回归一化结果
	 * @param {string} [opts.uiId] - 注入 uiId（仅测试）
	 * @param {() => number} [opts.now] - 时间源（仅测试）
	 */
	constructor(opts) {
		if (!opts || typeof opts.send !== 'function') {
			throw new Error('RemoteLog: opts.send is required');
		}
		this.__send = opts.send;
		this.uiId = opts.uiId || nanoid(UI_ID_LENGTH);
		this.__now = opts.now || (() => Date.now());

		this.__seq = 0;
		/** @type {{ ts: number, text: string }[]} */
		this.__ring = [];
		/** @type {PendingBatch[]} */
		this.__pending = [];
		this.__debounceTimer = null;
		this.__draining = false;
		this.__abortController = new AbortController();
		/** @type {{ conn: any, fn: (text: string) => void } | null} */
		this.__sigBridge = null;
	}

	// 状态唯一来源：AbortSignal；__stopped 包成 getter 让循环里继续按习惯读写
	get __stopped() { return this.__abortController.signal.aborted; }

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
			}, DEBOUNCE);
		}
	}

	/** 把 ring buffer 全部封批入待发队列，然后无条件 kick drain。*/
	__pack() {
		if (this.__debounceTimer) {
			clearTimeout(this.__debounceTimer);
			this.__debounceTimer = null;
		}
		while (this.__ring.length > 0) {
			const logs = this.__ring.splice(0, BATCH_SIZE);
			this.__seq += 1;
			this.__pending.push({
				uiId: this.uiId,
				seq: this.__seq,
				logs,
			});
			while (this.__pending.length > MAX_PENDING) {
				this.__pending.shift();
			}
		}
		// 无条件 kick——靠 __drain 入口重入守卫自洽，避免"push 与 running=false 之间的瞬时窗口"
		this.__drain().catch((err) => {
			console.warn('[remote-log] drain crashed:', err?.message);
		});
	}

	/** 单 async 消费循环：重入守卫 + while 直到 __pending 跑空。*/
	async __drain() {
		if (this.__draining || this.__stopped) return;
		this.__draining = true;
		try {
			while (this.__pending.length > 0) {
				if (this.__stopped) return;
				const batch = this.__pending.shift();
				await this.__sendBatchWithRetry(batch);
			}
		} finally {
			this.__draining = false;
		}
	}

	/**
	 * 单 batch 重试调度：for 循环走完 `RETRY_DELAYS.length + 1` 次发送（首发 + N 次重试）。
	 * abort 判定**全程依赖 `signal.aborted`**，不依赖 error name——
	 * axios v1 cancel 抛 `CanceledError`、`__sleep` abort 抛自定义 error，二者 name 不一致。
	 * @param {PendingBatch} batch
	 */
	async __sendBatchWithRetry(batch) {
		const { signal } = this.__abortController;
		const payload = { uiId: batch.uiId, seq: batch.seq, logs: batch.logs };
		const totalSends = RETRY_DELAYS.length + 1;
		for (let attempt = 0; attempt < totalSends; attempt += 1) {
			if (signal.aborted) return;
			let res;
			try {
				res = await this.__send(payload, signal);
			} catch (err) {
				res = { kind: 'network', error: err };
			}
			if (signal.aborted) return;
			if (res?.kind === 'success' || res?.kind === 'badRequest') return;
			const isLast = attempt === totalSends - 1;
			if (isLast) {
				console.warn(`[remote-log] batch dropped after ${totalSends} sends seq=${batch.seq} kind=${res?.kind || 'unknown'}`);
				return;
			}
			let delay = RETRY_DELAYS[attempt];
			if (res?.kind === 'retryable'
				&& typeof res.retryAfter === 'number'
				&& Number.isFinite(res.retryAfter)
				&& res.retryAfter >= 0) {
				delay = Math.min(res.retryAfter, RETRY_AFTER_CAP);
			}
			try {
				await sleep(delay, signal);
			} catch (err) {
				// 当前 sleep 只在 abort 时 reject；非 abort 路径理论不可达，留一行警告以可观测
				if (!signal.aborted) {
					console.warn('[remote-log] unexpected sleep reject:', err?.message);
				}
				return;
			}
		}
	}

	/**
	 * 立即封批并推动发送循环。供调用方在需要确定性收尾的场景使用（如单测）。
	 */
	flush() {
		this.__pack();
	}

	/**
	 * 停止后续发送 / 定时器，并解绑 sigConn 桥接监听器。
	 * 等同于 controller.abort()——in-flight axios 与正在 sleep 的 retry 都会立刻退出。
	 * 生产代码不调用此方法；保留供测试与未来扩展。
	 */
	stop() {
		if (this.__abortController.signal.aborted) return;
		this.__abortController.abort();
		if (this.__debounceTimer) {
			clearTimeout(this.__debounceTimer);
			this.__debounceTimer = null;
		}
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
 * 把 axios 响应/异常归一化为 SendResult。axios cancel 抛出的错误会被 catch 走入 network 分支，
 * 上层 `__sendBatchWithRetry` 在 await 之后通过 `signal.aborted` 区分 abort 与真实失败。
 * @param {import('axios').AxiosInstance} http
 * @param {{ uiId: string, seq: number, logs: { ts: number, text: string }[] }} payload
 * @param {AbortSignal} [signal]
 * @returns {Promise<SendResult>}
 */
export async function httpSender(http, payload, signal) {
	try {
		await http.post(ENDPOINT_PATH, payload, { timeout: HTTP_TIMEOUT, signal });
		return { kind: 'success' };
	} catch (err) {
		const status = err?.response?.status;
		const headers = err?.response?.headers;
		const retryAfter = parseRetryAfter(headers?.['retry-after']);
		if (status === 408 || status === 429) {
			return { kind: 'retryable', retryAfter };
		}
		if (typeof status === 'number' && status >= 500 && status < 600) {
			return { kind: 'retryable', retryAfter };
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
		withCredentials: true, // cookie 用于服务端身份标注（user vs anon）
	});
	return __dedicatedClient;
}

/**
 * 获取 RemoteLog 单例。首次调用时初始化：生成 uiId / 桥接 sigConn 的 log 事件。
 *
 * 端点不强制登录态，UI 实例发送行为与登录态完全解耦——不挂任何 login/logout flush hook、
 * 不 watch authStore；登录前 / 登录失败窗口的 log 同样能上送 server。
 *
 * ui.start 等启动期诊断 log 由 caller（app 入口）显式调 `remoteLog(buildUiStartText(...))` 发送，
 * 见 `services/env-snapshot.js`。
 *
 * @param {Object} [opts]
 * @param {(payload: { uiId: string, seq: number, logs: { ts: number, text: string }[] }, signal: AbortSignal) => Promise<SendResult>} [opts.send] - 发送函数（测试注入）
 * @param {string} [opts.uiId] - 注入 uiId（测试用）
 * @param {boolean} [opts.skipSigBridge] - 跳过 signaling-connection 桥接（测试用）
 * @returns {RemoteLog}
 */
export function useRemoteLog(opts = {}) {
	if (__instance) return __instance;
	const send = opts.send || ((payload, signal) => httpSender(getDedicatedClient(), payload, signal));
	__instance = new RemoteLog({
		send,
		uiId: opts.uiId,
	});
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
