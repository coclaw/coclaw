import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { clearConfig, getBindingsPath, readConfig } from './config.js';
import {
	loadOrCreateDeviceIdentity,
	signDevicePayload,
	publicKeyRawBase64Url,
	buildDeviceAuthPayloadV3,
} from './device-identity.js';
import { getRuntime } from './runtime.js';

const DEFAULT_GATEWAY_WS_URL = `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || '18789'}`;
const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const SERVER_HB_PING_MS = 25_000;
const SERVER_HB_TIMEOUT_MS = 45_000;
const SERVER_HB_MAX_MISS = 4; // 连续 4 次无响应才断连（~3 分钟）

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
	 * @param {Function} [deps.loadDeviceIdentity] - 加载设备身份
	 */
	constructor(deps = {}) {
		this.__readConfig = deps.readConfig ?? readConfig;
		this.__clearConfig = deps.clearConfig ?? clearConfig;
		this.__getBindingsPath = deps.getBindingsPath ?? getBindingsPath;
		this.__resolveGatewayAuthToken = deps.resolveGatewayAuthToken ?? defaultResolveGatewayAuthToken;
		this.__loadDeviceIdentity = deps.loadDeviceIdentity ?? loadOrCreateDeviceIdentity;
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
		this.logger = console;
		this.pluginConfig = {};
		this.intentionallyClosed = false;
		this.serverHbInterval = null;
		this.serverHbTimer = null;
		this.__serverHbMissCount = 0;
		this.__deviceIdentity = null;
		this.webrtcPeer = null;
	}

	__resolveWebSocket() {
		return this.__WebSocket ?? globalThis.WebSocket;
	}

	__logDebug(message) {
		if (typeof this.logger?.debug === 'function') {
			this.logger.debug(`[coclaw] ${message}`);
		}
	}

	__startServerHeartbeat(sock) {
		this.__clearServerHeartbeat();
		this.__serverHbMissCount = 0;
		this.serverHbInterval = setInterval(() => {
			if (sock.readyState === 1) {
				try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
			}
		}, SERVER_HB_PING_MS);
		this.serverHbInterval.unref?.();
		this.__resetServerHbTimeout(sock);
	}

	__resetServerHbTimeout(sock) {
		this.__serverHbMissCount = 0;
		if (this.serverHbTimer) clearTimeout(this.serverHbTimer);
		this.serverHbTimer = setTimeout(() => {
			this.__onServerHbMiss(sock);
		}, SERVER_HB_TIMEOUT_MS);
		this.serverHbTimer.unref?.();
	}

	__onServerHbMiss(sock) {
		this.__serverHbMissCount++;
		if (this.__serverHbMissCount < SERVER_HB_MAX_MISS) {
			this.__logDebug(
				`server heartbeat miss ${this.__serverHbMissCount}/${SERVER_HB_MAX_MISS}, will retry`
			);
			// 补发 ping，继续等下一轮
			if (sock.readyState === 1) {
				try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
			}
			this.serverHbTimer = setTimeout(() => {
				this.__onServerHbMiss(sock);
			}, SERVER_HB_TIMEOUT_MS);
			this.serverHbTimer.unref?.();
			return;
		}
		this.logger.warn?.(
			`[coclaw] server ws heartbeat timeout after ${this.__serverHbMissCount} consecutive misses (~${this.__serverHbMissCount * SERVER_HB_TIMEOUT_MS / 1000}s), closing`
		);
		try { sock.close(4000, 'heartbeat_timeout'); } catch {}
	}

	__clearServerHeartbeat() {
		if (this.serverHbInterval) { clearInterval(this.serverHbInterval); this.serverHbInterval = null; }
		if (this.serverHbTimer) { clearTimeout(this.serverHbTimer); this.serverHbTimer = null; }
	}

	__resolveGatewayWsUrl() {
		return this.pluginConfig?.gatewayWsUrl
			?? process.env.COCLAW_GATEWAY_WS_URL
			?? DEFAULT_GATEWAY_WS_URL;
	}

	async __clearTokenLocal(unboundBotId) {
		const cfg = await this.__readConfig();
		if (!cfg?.token) {
			return;
		}
		// 只清除匹配的 bot，避免新绑定被误清
		if (unboundBotId && cfg.botId && cfg.botId !== unboundBotId) {
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

	/**
	 * 两阶段 agent RPC：发送请求后等待 accepted 再等待最终响应。
	 * agent() RPC 返回两次响应（同一 id）：
	 *   1. { status: "accepted", runId }
	 *   2. { status: "ok", result: { payloads: [{ text }] } }
	 *
	 * @param {string} method - RPC 方法名（通常为 'agent'）
	 * @param {object} params - RPC 参数
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs=60000] - 总超时（含两阶段）
	 * @param {number} [options.acceptTimeoutMs=10000] - 等待 accepted 的超时
	 * @returns {Promise<{ok: boolean, response?: object, error?: string}>}
	 */
	async __gatewayAgentRpc(method, params = {}, options = {}) {
		const totalTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000;
		const acceptTimeoutMs = Number.isFinite(options.acceptTimeoutMs) ? options.acceptTimeoutMs : 10_000;
		const ready = await this.__waitGatewayReady(acceptTimeoutMs);
		/* c8 ignore next 3 -- waitGatewayReady 返回 false 后的防御检查 */
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1 || !this.gatewayReady) {
			return { ok: false, error: 'gateway_not_ready' };
		}
		const ws = this.gatewayWs;
		const id = this.__nextGatewayReqId('coclaw-agent');
		return await new Promise((resolve) => {
			let settled = false;
			let accepted = false;
			let totalTimer = null;
			let acceptTimer = null;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				if (totalTimer) clearTimeout(totalTimer);
				if (acceptTimer) clearTimeout(acceptTimer);
				this.gatewayPendingRequests.delete(id);
				resolve(result);
			};
			// 两阶段 settle：第一次 accepted 不 resolve，第二次才 resolve
			const settle = (result) => {
				if (settled) return;
				// 错误响应：直接结束
				if (!result.ok) {
					finish(result);
					return;
				}
				const status = result.response?.payload?.status;
				if (!accepted && status === 'accepted') {
					// 第一阶段：已接受，切换到总超时
					accepted = true;
					if (acceptTimer) clearTimeout(acceptTimer);
					return;
				}
				// 第二阶段或非 accepted 响应：最终结果
				finish(result);
			};
			this.gatewayPendingRequests.set(id, settle);
			// 总超时
			totalTimer = setTimeout(() => finish({ ok: false, error: 'timeout' }), totalTimeoutMs);
			totalTimer.unref?.();
			// accepted 超时（仅等第一阶段）
			acceptTimer = setTimeout(() => {
				if (!accepted) finish({ ok: false, error: 'accept_timeout' });
			}, acceptTimeoutMs);
			acceptTimer.unref?.();
			try {
				ws.send(JSON.stringify({ type: 'req', id, method, params }));
			}
			/* c8 ignore next 3 -- ws.send 极少抛出 */
			catch {
				finish({ ok: false, error: 'send_failed' });
			}
		});
	}

	/**
	 * 确保指定 agent 的主 session 存在（sessions.resolve + 条件 sessions.reset）
	 * @param {string} [agentId] - agent ID，默认 'main'
	 * @returns {Promise<{ok: boolean, state?: string, error?: string}>}
	 */
	async ensureAgentSession(agentId) {
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		const key = `agent:${aid}:main`;
		const resolved = await this.__gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
		if (resolved?.ok === true) {
			this.__logDebug(`ensure agent session: ready agentId=${aid}`);
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
		this.__logDebug(`ensure agent session: created agentId=${aid}`);
		return { ok: true, state: 'created' };
	}

	async __ensureAllAgentSessions() {
		try {
			const listResult = await this.__gatewayRpc('agents.list', {}, { timeoutMs: 3000 });
			let agentIds = ['main'];
			if (listResult?.ok === true && Array.isArray(listResult?.response?.payload?.agents)) {
				const ids = listResult.response.payload.agents
					.map((a) => a?.id)
					.filter((id) => typeof id === 'string' && id.trim());
				if (ids.length > 0) agentIds = ids;
			}
			else {
				this.logger.warn?.(`[coclaw] agents.list failed, falling back to main: ${listResult?.error ?? 'unknown'}`);
			}
			const results = await Promise.allSettled(
				agentIds.map((id) => this.ensureAgentSession(id)),
			);
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r.status === 'fulfilled' && r.value?.ok) continue;
				const err = r.status === 'fulfilled' ? r.value?.error : String(r.reason);
				this.logger.warn?.(`[coclaw] ensure agent session failed: agentId=${agentIds[i]} error=${err ?? 'unknown'}`);
			}
		}
		/* c8 ignore next 3 -- 防御性兜底，__gatewayRpc 内部已有完整错误处理 */
		catch (err) {
			this.logger.warn?.(`[coclaw] ensureAllAgentSessions unexpected error: ${String(err?.message ?? err)}`);
		}
	}

	__ensureDeviceIdentity() {
		if (!this.__deviceIdentity) {
			this.__deviceIdentity = this.__loadDeviceIdentity();
		}
		return this.__deviceIdentity;
	}

	__buildDeviceField(nonce, authToken) {
		const identity = this.__ensureDeviceIdentity();
		const clientId = 'gateway-client';
		const clientMode = 'backend';
		const role = 'operator';
		const scopes = ['operator.admin'];
		const signedAtMs = Date.now();
		const payload = buildDeviceAuthPayloadV3({
			deviceId: identity.deviceId,
			clientId,
			clientMode,
			role,
			scopes,
			signedAtMs,
			token: authToken ?? '',
			nonce: nonce ?? '',
			platform: process.platform,
			deviceFamily: '',
		});
		const signature = signDevicePayload(identity.privateKeyPem, payload);
		return {
			id: identity.deviceId,
			publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
			signature,
			signedAt: signedAtMs,
			nonce: nonce ?? '',
		};
	}

	__sendGatewayConnectRequest(ws, nonce) {
		this.gatewayConnectReqId = `coclaw-connect-${Date.now()}`;
		this.__logDebug(`gateway connect request -> id=${this.gatewayConnectReqId}`);
		try {
			const authToken = this.__resolveGatewayAuthToken();
			const device = this.__buildDeviceField(nonce, authToken);
			const params = {
				minProtocol: 3,
				maxProtocol: 3,
				client: {
					id: 'gateway-client',
					version: 'dev',
					platform: process.platform,
					mode: 'backend',
				},
				caps: ['tool-events'],
				role: 'operator',
				scopes: ['operator.admin'],
				auth: authToken ? { token: authToken } : undefined,
				device,
			};
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
				const nonce = payload?.payload?.nonce ?? '';
				this.__logDebug('gateway event <- connect.challenge');
				this.__sendGatewayConnectRequest(ws, nonce);
				return;
			}
			if (payload.type === 'res' && this.gatewayConnectReqId && payload.id === this.gatewayConnectReqId) {
				if (payload.ok === true) {
					this.gatewayReady = true;
					this.__logDebug(`gateway connect ok <- id=${payload.id}`);
					this.gatewayConnectReqId = null;
					this.__ensureSessionsPromise = this.__ensureAllAgentSessions();
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
				this.webrtcPeer?.broadcast(payload);
			}
		});

		ws.addEventListener('open', () => {
			// wait for connect.challenge
		});
		ws.addEventListener('close', () => {
			this.gatewayWs = null;
			this.gatewayReady = false;
			this.gatewayConnectReqId = null;
			/* c8 ignore next 3 -- gateway 意外断开时结算未完成 RPC，避免等超时 */
			for (const [, settle] of this.gatewayPendingRequests) {
				settle({ ok: false, error: 'gateway_closed' });
			}
			this.gatewayPendingRequests.clear();
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
			const errorRes = {
				type: 'res',
				id: payload.id,
				ok: false,
				error: {
					code: 'GATEWAY_OFFLINE',
					message: 'Gateway is offline',
				},
			};
			this.__forwardToServer(errorRes);
			this.webrtcPeer?.broadcast(errorRes);
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
			const errorRes = {
				type: 'res',
				id: payload.id,
				ok: false,
				error: {
					code: 'GATEWAY_SEND_FAILED',
					message: 'Failed to send request to gateway',
				},
			};
			this.__forwardToServer(errorRes);
			this.webrtcPeer?.broadcast(errorRes);
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
			this.__startServerHeartbeat(sock);
			this.__ensureGatewayConnection();
		});

		sock.addEventListener('message', async (event) => {
			this.__resetServerHbTimeout(sock);
			try {
				const payload = JSON.parse(String(event.data ?? '{}'));
				if (payload?.type === 'bot.unbound') {
					await this.__clearTokenLocal(payload.botId);
					try { sock.close(4001, 'bot_unbound'); }
					/* c8 ignore next */
					catch {}
					return;
				}
				if (payload?.type?.startsWith('rtc:')) {
					try {
						if (!this.webrtcPeer) {
							const { WebRtcPeer } = await import('./webrtc-peer.js');
							this.webrtcPeer = new WebRtcPeer({
								onSend: (msg) => this.__forwardToServer(msg),
								onRequest: (dcPayload) => {
									void this.__handleGatewayRequestFromServer(dcPayload);
								},
								logger: this.logger,
							});
						}
						await this.webrtcPeer.handleSignaling(payload);
					} catch (err) {
						this.logger.warn?.(`[coclaw/rtc] signaling error (or werift not found): ${err?.message}`);
					}
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
			this.__clearServerHeartbeat();
			this.__clearConnectTimer();
			// 若 serverWs 已指向新实例（如 refresh 后），跳过旧 sock 的清理
			if (this.serverWs !== null && this.serverWs !== sock) {
				return;
			}
			const wasIntentional = this.intentionallyClosed;
			this.serverWs = null;
			this.intentionallyClosed = false;
			this.__closeGatewayWs();
			if (this.webrtcPeer) {
				try { await this.webrtcPeer.closeAll(); }
				/* c8 ignore next 3 -- 防御性兜底，werift close 异常时不可崩溃 gateway */
				catch (e) { this.logger.warn?.(`[coclaw/rtc] closeAll failed: ${e?.message}`); }
				this.webrtcPeer = null;
			}

			if (event?.code === 4001 || event?.code === 4003) {
				try {
					await this.__clearTokenLocal();
				}
				/* c8 ignore next 3 -- 防御性兜底，磁盘 I/O 异常时不可崩溃 gateway */
				catch (e) {
					this.logger.error?.('[coclaw] clearTokenLocal failed on auth-close', e);
				}
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
			this.__clearServerHeartbeat();
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
		this.__clearServerHeartbeat();
		this.__clearConnectTimer();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.__closeGatewayWs();
		if (this.webrtcPeer) {
			await this.webrtcPeer.closeAll().catch(() => {});
			this.webrtcPeer = null;
		}
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
// 仅暴露 restartRealtimeBridge / stopRealtimeBridge 两个操作：
//   restart(opts) — 无论当前状态，确保 bridge 以给定 opts 运行（幂等）
//   stop()        — 停止并销毁 singleton
// 调用方无需感知 singleton 是否为 null，选"要运行"或"要停止"即可。

let singleton = null;

/**
 * 确保 bridge 运行：已有实例则 stop 后重建，无则直接创建。opts 必传。
 * @param {{ logger, pluginConfig }} opts
 */
export async function restartRealtimeBridge(opts) {
	if (singleton) {
		await singleton.stop();
		singleton = null;
	}
	singleton = new RealtimeBridge();
	await singleton.start(opts);
}

export async function stopRealtimeBridge() {
	if (!singleton) {
		return;
	}
	await singleton.stop();
	singleton = null; // 置 null 后须通过 restartRealtimeBridge 重建
}

export async function waitForSessionsReady() {
	if (!singleton?.__ensureSessionsPromise) return;
	await singleton.__ensureSessionsPromise;
}

export async function ensureAgentSession(agentId) {
	if (!singleton) {
		return { ok: false, error: 'bridge_not_started' };
	}
	return singleton.ensureAgentSession(agentId);
}

/**
 * 通过 gateway WS 发起两阶段 agent RPC（供标题生成等场景使用）
 * @param {string} method
 * @param {object} params
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, response?: object, error?: string}>}
 */
export async function gatewayAgentRpc(method, params, options) {
	if (!singleton) {
		return { ok: false, error: 'bridge_not_started' };
	}
	return singleton.__gatewayAgentRpc(method, params, options);
}
