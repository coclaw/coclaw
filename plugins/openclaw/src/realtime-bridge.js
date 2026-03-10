import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { clearConfig, getBindingsPath, readConfig } from './config.js';
import { getRuntime } from './runtime.js';

const DEFAULT_GATEWAY_WS_URL = 'ws://127.0.0.1:18789';
const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

function toServerWsUrl(baseUrl, token) {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/api/v1/bots/stream';
	url.searchParams.set('token', token);
	return url.toString();
}

// 脱敏 URL 中的 token 参数，用于日志输出
function maskUrlToken(url) {
	return url.replace(/([?&]token=)[^&]+/, '$1***');
}

/* c8 ignore start -- 仅在未注入 resolveGatewayAuthToken 时使用，依赖 runtime/env/文件系统 */
function defaultResolveGatewayAuthToken() {
	const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
	if (envToken) {
		return envToken;
	}
	try {
		const rt = getRuntime();
		if (rt?.config?.loadConfig) {
			const cfg = rt.config.loadConfig();
			const token = cfg?.gateway?.auth?.token;
			return typeof token === 'string' && token.trim() ? token.trim() : '';
		}
		const cfgPath = process.env.OPENCLAW_CONFIG_PATH
			? nodePath.resolve(process.env.OPENCLAW_CONFIG_PATH)
			: nodePath.join(os.homedir(), '.openclaw', 'openclaw.json');
		const raw = fs.readFileSync(cfgPath, 'utf8');
		const cfg = JSON.parse(raw);
		const token = cfg?.gateway?.auth?.token;
		return typeof token === 'string' && token.trim() ? token.trim() : '';
	}
	catch {
		return '';
	}
}
/* c8 ignore stop */

/**
 * WebSocket 桥接器：CoClaw server ↔ OpenClaw gateway
 *
 * 所有连接状态封装在实例内部，便于生命周期管理和测试。
 */
export class RealtimeBridge {
	/**
	 * @param {object} [deps] - 可注入依赖（测试用）
	 * @param {Function} [deps.WebSocket] - WebSocket 构造函数
	 * @param {Function} [deps.readConfig] - 读取绑定配置
	 * @param {Function} [deps.clearConfig] - 清除绑定配置
	 * @param {Function} [deps.getBindingsPath] - 获取绑定文件路径
	 * @param {Function} [deps.resolveGatewayAuthToken] - 获取 gateway 认证 token
	 */
	constructor(deps = {}) {
		this.__readConfig = deps.readConfig ?? readConfig;
		this.__clearConfig = deps.clearConfig ?? clearConfig;
		this.__getBindingsPath = deps.getBindingsPath ?? getBindingsPath;
		this.__resolveGatewayAuthToken = deps.resolveGatewayAuthToken ?? defaultResolveGatewayAuthToken;
		this.__WebSocket = deps.WebSocket ?? null;

		this.serverWs = null;
		this.gatewayWs = null;
		this.reconnectTimer = null;
		this.connectTimer = null;
		this.started = false;
		this.gatewayReady = false;
		this.gatewayConnectReqId = null;
		this.gatewayRpcSeq = 0;
		this.gatewayPendingRequests = new Map();
		this.mainSessionEnsurePromise = null;
		this.mainSessionEnsured = false;
		this.logger = console;
		this.pluginConfig = {};
		this.intentionallyClosed = false;
	}

	__resolveWebSocket() {
		return this.__WebSocket ?? globalThis.WebSocket;
	}

	__logDebug(message) {
		if (typeof this.logger?.debug === 'function') {
			this.logger.debug(`[coclaw] ${message}`);
		}
	}

	__resolveGatewayWsUrl() {
		return this.pluginConfig?.gatewayWsUrl
			?? process.env.COCLAW_GATEWAY_WS_URL
			?? DEFAULT_GATEWAY_WS_URL;
	}

	async __clearTokenLocal() {
		const cfg = await this.__readConfig();
		if (!cfg?.token) {
			return;
		}
		await this.__clearConfig();
	}

	__closeGatewayWs() {
		if (!this.gatewayWs) {
			return;
		}
		try {
			this.gatewayWs.close(1000, 'server-disconnect');
		}
		/* c8 ignore next */
		catch {}
		this.gatewayWs = null;
		this.gatewayReady = false;
		this.gatewayConnectReqId = null;
		/* c8 ignore next 3 -- 仅在有未完成 RPC 请求时 gateway 关闭时触发 */
		for (const [, settle] of this.gatewayPendingRequests) {
			settle({ ok: false, error: 'gateway_closed' });
		}
		this.gatewayPendingRequests.clear();
	}

	/* c8 ignore next 7 -- 防御性检查，serverWs 通常在调用时可用 */
	__forwardToServer(payload) {
		if (!this.serverWs || this.serverWs.readyState !== 1) {
			return;
		}
		try {
			this.serverWs.send(JSON.stringify(payload));
		}
		/* c8 ignore next */
		catch {}
	}

	__nextGatewayReqId(prefix = 'coclaw-rpc') {
		this.gatewayRpcSeq += 1;
		return `${prefix}-${Date.now()}-${this.gatewayRpcSeq}`;
	}

	async __gatewayRpc(method, params = {}, options = {}) {
		const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
		const ready = await this.__waitGatewayReady(timeoutMs);
		/* c8 ignore next 3 -- waitGatewayReady 返回 false 后的防御检查 */
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1 || !this.gatewayReady) {
			return { ok: false, error: 'gateway_not_ready' };
		}
		const ws = this.gatewayWs;
		const id = this.__nextGatewayReqId('coclaw-gw');
		return await new Promise((resolve) => {
			let finished = false;
			const settle = (result) => {
				/* c8 ignore next 3 -- 防御并发 settle */
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				this.gatewayPendingRequests.delete(id);
				resolve(result);
			};
			this.gatewayPendingRequests.set(id, settle);
			const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs);
			timer.unref?.();
			try {
				ws.send(JSON.stringify({
					type: 'req',
					id,
					method,
					params,
				}));
			}
			/* c8 ignore next 3 -- ws.send 极少抛出 */
			catch {
				settle({ ok: false, error: 'send_failed' });
			}
		});
	}

	async __ensureMainSessionKey() {
		if (this.mainSessionEnsured) {
			return { ok: true, state: 'ready' };
		}
		/* c8 ignore next 3 -- 并发调用防御，复用进行中的 promise */
		if (this.mainSessionEnsurePromise) {
			return await this.mainSessionEnsurePromise;
		}
		this.mainSessionEnsurePromise = (async () => {
			const key = 'agent:main:main';
			// sessions.resolve 仅返回 { ok, key }，不含 entry
			const resolved = await this.__gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
			if (resolved?.ok === true) {
				this.mainSessionEnsured = true;
				this.__logDebug(`main session key ensure: ready key=${key}`);
				return { ok: true, state: 'ready' };
			}
			// 仅当网关真实响应 "不存在" 时才创建；超时/网关未就绪等瞬态错误不触发 reset
			if (!resolved?.response) {
				return { ok: false, error: resolved?.error ?? 'resolve_transient_failure' };
			}
			// session key 不存在，通过 sessions.reset 创建
			const reset = await this.__gatewayRpc('sessions.reset', { key, reason: 'new' }, { timeoutMs: 2500 });
			if (reset?.ok !== true) {
				return { ok: false, error: reset?.error ?? 'sessions_reset_failed' };
			}
			this.mainSessionEnsured = true;
			this.__logDebug(`main session key ensure: created key=${key}`);
			return { ok: true, state: 'created' };
		})();
		try {
			const result = await this.mainSessionEnsurePromise;
			if (!result?.ok) {
				this.logger.warn?.(`[coclaw] ensure main session key failed: ${result?.error ?? 'unknown'}`);
			}
			return result;
		}
		finally {
			this.mainSessionEnsurePromise = null;
		}
	}

	__sendGatewayConnectRequest(ws) {
		this.gatewayConnectReqId = `coclaw-connect-${Date.now()}`;
		this.__logDebug(`gateway connect request -> id=${this.gatewayConnectReqId}`);
		const authToken = this.__resolveGatewayAuthToken();
		const params = {
			minProtocol: 3,
			maxProtocol: 3,
			client: {
				id: 'gateway-client',
				version: 'dev',
				platform: process.platform,
				mode: 'backend',
			},
			caps: [],
			role: 'operator',
			scopes: ['operator.admin'],
			auth: authToken ? { token: authToken } : undefined,
		};
		try {
			ws.send(JSON.stringify({
				type: 'req',
				id: this.gatewayConnectReqId,
				method: 'connect',
				params,
			}));
		}
		catch {
			this.gatewayConnectReqId = null;
		}
	}

	__ensureGatewayConnection() {
		if (this.gatewayWs || !this.serverWs || this.serverWs.readyState !== 1) {
			return;
		}
		const WebSocketCtor = this.__resolveWebSocket();
		/* c8 ignore next 3 -- 已在 __connectIfNeeded 中守卫 */
		if (!WebSocketCtor) {
			return;
		}
		const ws = new WebSocketCtor(this.__resolveGatewayWsUrl());
		this.gatewayWs = ws;
		this.gatewayReady = false;
		this.gatewayConnectReqId = null;

		ws.addEventListener('message', (event) => {
			let payload = null;
			try {
				payload = JSON.parse(String(event.data ?? '{}'));
			}
			catch {
				return;
			}
			if (!payload || typeof payload !== 'object') {
				return;
			}
			if (payload.type === 'event' && payload.event === 'connect.challenge') {
				this.__logDebug('gateway event <- connect.challenge');
				this.__sendGatewayConnectRequest(ws);
				return;
			}
			if (payload.type === 'res' && this.gatewayConnectReqId && payload.id === this.gatewayConnectReqId) {
				if (payload.ok === true) {
					this.gatewayReady = true;
					this.__logDebug(`gateway connect ok <- id=${payload.id}`);
					this.gatewayConnectReqId = null;
					void this.__ensureMainSessionKey();
				}
				else {
					this.gatewayReady = false;
					this.gatewayConnectReqId = null;
					this.logger.warn?.(`[coclaw] gateway connect failed: ${payload?.error?.message ?? 'unknown'}`);
					try { ws.close(1008, 'gateway_connect_failed'); }
					/* c8 ignore next */
					catch {}
				}
				return;
			}
			if (payload.type === 'res' && typeof payload.id === 'string') {
				const settle = this.gatewayPendingRequests.get(payload.id);
				if (settle) {
					settle({
						ok: payload.ok === true,
						response: payload,
						error: payload?.error?.message ?? payload?.error?.code,
					});
					return;
				}
			}
			/* c8 ignore next 3 -- connect 完成前的消息过滤 */
			if (!this.gatewayReady) {
				return;
			}
			if (payload.type === 'res' || payload.type === 'event') {
				this.__forwardToServer(payload);
			}
		});

		ws.addEventListener('open', () => {
			// wait for connect.challenge
		});
		ws.addEventListener('close', () => {
			this.gatewayWs = null;
			this.gatewayReady = false;
			this.gatewayConnectReqId = null;
		});
		ws.addEventListener('error', () => {});
	}

	async __waitGatewayReady(timeoutMs = 1500) {
		this.__ensureGatewayConnection();
		if (this.gatewayWs && this.gatewayWs.readyState === 1 && this.gatewayReady) {
			return true;
		}
		const ws = this.gatewayWs;
		/* c8 ignore next 3 -- serverWs 为 null 时 ensureGatewayConnection 不创建 gatewayWs */
		if (!ws) {
			return false;
		}
		return await new Promise((resolve) => {
			let done = false;
			const finish = (ok) => {
				/* c8 ignore next 3 -- 防御并发 finish */
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				clearInterval(poller);
				ws.removeEventListener?.('error', onError);
				ws.removeEventListener?.('close', onClose);
				resolve(ok);
			};
			/* c8 ignore next */
			const onError = () => finish(false);
			const onClose = () => finish(false);
			/* c8 ignore next 10 -- 轮询检测 gateway ready，时序依赖难以在单测中精确触发 */
			const poller = setInterval(() => {
				if (this.gatewayWs !== ws) {
					finish(false);
					return;
				}
				if (this.gatewayReady && ws.readyState === 1) {
					finish(true);
				}
			}, 25);
			poller.unref?.();
			const timer = setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
			ws.addEventListener('error', onError);
			ws.addEventListener('close', onClose);
		});
	}

	async __handleGatewayRequestFromServer(payload) {
		const ready = await this.__waitGatewayReady();
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
			this.__logDebug(`gateway req drop (offline): id=${payload.id} method=${payload.method}`);
			this.__forwardToServer({
				type: 'res',
				id: payload.id,
				ok: false,
				error: {
					code: 'GATEWAY_OFFLINE',
					message: 'Gateway is offline',
				},
			});
			return;
		}
		try {
			this.__logDebug(`gateway req -> id=${payload.id} method=${payload.method}`);
			this.gatewayWs.send(JSON.stringify({
				type: 'req',
				id: payload.id,
				method: payload.method,
				params: payload.params ?? {},
			}));
		}
		catch {
			this.__forwardToServer({
				type: 'res',
				id: payload.id,
				ok: false,
				error: {
					code: 'GATEWAY_SEND_FAILED',
					message: 'Failed to send request to gateway',
				},
			});
		}
	}

	__clearConnectTimer() {
		if (!this.connectTimer) {
			return;
		}
		clearTimeout(this.connectTimer);
		this.connectTimer = null;
	}

	__scheduleReconnect() {
		if (!this.started || this.reconnectTimer) {
			return;
		}
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			await this.__connectIfNeeded();
		}, RECONNECT_MS);
		this.reconnectTimer.unref?.();
	}

	async __connectIfNeeded() {
		/* c8 ignore next 3 -- 仅从 start/reconnect 内部调用，条件不满足时的防御 */
		if (!this.started || this.serverWs) {
			return;
		}

		const bindingsPath = this.__getBindingsPath();
		const cfg = await this.__readConfig();
		if (!cfg?.token) {
			this.logger.warn?.(`[coclaw] realtime bridge skip connect: missing token in ${bindingsPath}`);
			return;
		}

		const baseUrl = cfg.serverUrl;
		if (!baseUrl) {
			this.logger.warn?.(`[coclaw] realtime bridge skip connect: missing serverUrl in ${bindingsPath}`);
			return;
		}
		const target = toServerWsUrl(baseUrl, cfg.token);
		const WebSocketCtor = this.__resolveWebSocket();
		if (!WebSocketCtor) {
			this.logger.warn?.('[coclaw] WebSocket not available, skip realtime bridge');
			return;
		}

		const maskedTarget = maskUrlToken(target);
		this.logger.info?.(`[coclaw] realtime bridge connecting: ${maskedTarget} (cfg: ${bindingsPath})`);
		this.intentionallyClosed = false;
		const sock = new WebSocketCtor(target);
		this.serverWs = sock;
		this.__clearConnectTimer();
		this.connectTimer = setTimeout(() => {
			/* c8 ignore next 3 -- 防御 stale timer 回调 */
			if (this.serverWs !== sock || this.intentionallyClosed) {
				return;
			}
			this.logger.warn?.(`[coclaw] realtime bridge connect timeout, will retry: ${maskedTarget}`);
			this.serverWs = null;
			this.__closeGatewayWs();
			this.__scheduleReconnect();
			try { sock.close(4000, 'connect_timeout'); }
			/* c8 ignore next */
			catch {}
		}, CONNECT_TIMEOUT_MS);
		this.connectTimer.unref?.();

		sock.addEventListener('open', () => {
			this.__clearConnectTimer();
			this.logger.info?.(`[coclaw] realtime bridge connected: ${maskedTarget}`);
			this.__ensureGatewayConnection();
		});

		sock.addEventListener('message', async (event) => {
			try {
				const payload = JSON.parse(String(event.data ?? '{}'));
				if (payload?.type === 'bot.unbound') {
					await this.__clearTokenLocal();
					try { sock.close(4001, 'bot_unbound'); }
					/* c8 ignore next */
					catch {}
					return;
				}
				if (payload?.type === 'req' || payload?.type === 'rpc.req') {
					void this.__handleGatewayRequestFromServer({
						id: payload.id,
						method: payload.method,
						params: payload.params ?? {},
					});
				}
			}
			catch (err) {
				this.logger.warn?.(`[coclaw] realtime message parse failed: ${String(err?.message ?? err)}`);
			}
		});

		sock.addEventListener('close', async (event) => {
			this.__clearConnectTimer();
			// 若 serverWs 已指向新实例（如 refresh 后），跳过旧 sock 的清理
			if (this.serverWs !== null && this.serverWs !== sock) {
				return;
			}
			const wasIntentional = this.intentionallyClosed;
			this.serverWs = null;
			this.intentionallyClosed = false;
			this.__closeGatewayWs();

			if (event?.code === 4001 || event?.code === 4003) {
				await this.__clearTokenLocal();
				return;
			}

			if (!wasIntentional) {
				this.logger.warn?.(`[coclaw] realtime bridge closed (${event?.code ?? 'unknown'}: ${event?.reason ?? 'n/a'}), will retry in ${RECONNECT_MS}ms`);
				this.__scheduleReconnect();
			}
		});

		sock.addEventListener('error', (err) => {
			if (this.serverWs !== sock || this.intentionallyClosed) {
				return;
			}
			this.__clearConnectTimer();
			this.logger.warn?.(`[coclaw] realtime bridge error, will retry in ${RECONNECT_MS}ms: ${String(err?.message ?? err)}`);
			this.serverWs = null;
			this.__closeGatewayWs();
			this.__scheduleReconnect();
			try { sock.close(4000, 'connect_error'); }
			/* c8 ignore next */
			catch {}
		});
	}

	async start({ logger, pluginConfig } = {}) {
		this.logger = logger ?? console;
		this.pluginConfig = pluginConfig ?? {};
		this.started = true;
		await this.__connectIfNeeded();
	}

	async refresh() {
		await this.stop();
		await this.start({
			logger: this.logger,
			pluginConfig: this.pluginConfig,
		});
	}

	async stop() {
		this.started = false;
		this.mainSessionEnsured = false;
		this.mainSessionEnsurePromise = null;
		this.__clearConnectTimer();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.__closeGatewayWs();
		const sock = this.serverWs;
		if (sock) {
			this.intentionallyClosed = true;
			this.serverWs = null;
			// 等待 WebSocket 真正关闭，避免残留连接收到 bot.unbound 等消息
			/* c8 ignore next -- readyState === 3 时跳过 */
			if (sock.readyState === 3) return;
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 3000);
				timer.unref?.();
				sock.addEventListener('close', () => {
					clearTimeout(timer);
					resolve();
				}, { once: true });
				try { sock.close(1000, 'stopped'); }
				/* c8 ignore next */
				catch { clearTimeout(timer); resolve(); }
			});
		}
	}
}

// --- 单例便捷 API（供 index.js 使用）---

let singleton = null;

export async function startRealtimeBridge(opts) {
	singleton = new RealtimeBridge();
	await singleton.start(opts);
}

export async function refreshRealtimeBridge() {
	if (!singleton) {
		return;
	}
	await singleton.refresh();
}

export async function stopRealtimeBridge() {
	if (!singleton) {
		return;
	}
	await singleton.stop();
}
