import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { WebSocket as WsWebSocket } from 'ws';

import { clearConfig, getBindingsPath, readConfig } from './config.js';
import { getHostName, readSettings } from './settings.js';
import {
	loadOrCreateDeviceIdentity,
	signDevicePayload,
	publicKeyRawBase64Url,
	buildDeviceAuthPayloadV3,
} from './device-identity.js';
import { getRuntime } from './runtime.js';
import { setSender as setRemoteLogSender, remoteLog } from './remote-log.js';
import { getPluginVersion } from './plugin-version.js';

const DEFAULT_GATEWAY_WS_URL = `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || '18789'}`;
const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const SERVER_HB_PING_MS = 25_000;
const SERVER_HB_TIMEOUT_MS = 45_000;
const SERVER_HB_MAX_MISS = 4; // 连续 4 次无响应才断连（~3 分钟）

function toServerWsUrl(baseUrl, token) {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/api/v1/claws/stream';
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
	catch (err) {
		console.warn?.(`[coclaw] resolve gateway auth token failed: ${String(err?.message ?? err)}`);
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
	 * @param {number} [deps.gatewayReadyTimeoutMs] - __waitGatewayReady 默认超时（测试可注入短值）
	 */
	constructor(deps = {}) {
		this.__readConfig = deps.readConfig ?? readConfig;
		this.__clearConfig = deps.clearConfig ?? clearConfig;
		this.__getBindingsPath = deps.getBindingsPath ?? getBindingsPath;
		this.__resolveGatewayAuthToken = deps.resolveGatewayAuthToken ?? defaultResolveGatewayAuthToken;
		this.__loadDeviceIdentity = deps.loadDeviceIdentity ?? loadOrCreateDeviceIdentity;
		this.__preloadNdc = deps.preloadNdc ?? null;
		this.__WebSocket = deps.WebSocket; // undefined=使用 ws 包, null=禁用（测试用）, 其他=自定义实现
		this.__gatewayReadyTimeoutMs = deps.gatewayReadyTimeoutMs ?? 1500;

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
		this.__webrtcPeerReady = null;
		this.__fileHandler = null;
		this.__ndcPreloadResult = null;
		this.__ndcCleanup = null;
	}

	__resolveWebSocket() {
		return this.__WebSocket === undefined ? WsWebSocket : this.__WebSocket;
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
		remoteLog(`ws.hb-timeout peer=server misses=${this.__serverHbMissCount}`);
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

	async __clearTokenLocal(unboundClawId) {
		const cfg = await this.__readConfig();
		if (!cfg?.token) {
			return;
		}
		// 只清除匹配的 claw，避免新绑定被误清
		if (unboundClawId && cfg.clawId && cfg.clawId !== unboundClawId) {
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

	/** 懒加载 WebRtcPeer（promise 锁防并发重复创建） */
	/* c8 ignore start -- 仅通过 WebRTC 路径触发，集成测试覆盖 */
	async __initWebrtcPeer() {
		const PeerConnection = this.__ndcPreloadResult?.PeerConnection;
		if (!PeerConnection) {
			remoteLog('rtc.unavailable reason=no-webrtc-impl');
			throw new Error('No WebRTC implementation available');
		}

		const { WebRtcPeer } = await import('./webrtc/webrtc-peer.js');
		const { createFileHandler } = await import('./file-manager/handler.js');
		this.__fileHandler = createFileHandler({
			resolveWorkspace: (agentId) => this.__resolveWorkspace(agentId),
			logger: this.logger,
		});
		this.__fileHandler.scheduleTmpCleanup(() => this.__listAgentWorkspaces());
		this.webrtcPeer = new WebRtcPeer({
			onSend: (msg) => this.__forwardToServer(msg),
			onRequest: (dcPayload) => {
				this.__handleGatewayRequestFromDc(dcPayload)
					.catch((err) => this.logger.warn?.(`[coclaw] dc request handler error: ${err?.message}`));
			},
			onFileRpc: (payload, sendFn) => {
				this.__fileHandler.handleRpcRequest(payload, sendFn)
					.catch((err) => this.logger.warn?.(`[coclaw/file] rpc error: ${err.message}`));
			},
			onFileChannel: (dc, connId) => {
				this.__fileHandler.handleFileChannel(dc, connId);
			},
			PeerConnection,
			logger: this.logger,
		});
	}
	/* c8 ignore stop */

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

	/** 推送实例名到 server 和已连接的 UI */
	async __pushInstanceName() {
		try {
			const settings = await readSettings();
			const name = settings.name ?? null;
			const hostName = getHostName();
			broadcastPluginEvent('coclaw.info.updated', { name, hostName });
		}
		catch (err) {
			/* c8 ignore next 2 -- 防御性兜底 */
			this.logger.warn?.(`[coclaw] pushInstanceName failed: ${String(err?.message ?? err)}`);
		}
	}

	/* c8 ignore start -- 仅通过 WebRTC 路径调用，依赖 gateway 连接，集成测试覆盖 */
	/**
	 * 通过 gateway RPC 获取指定 agent 的 workspace 绝对路径
	 * @param {string} agentId
	 * @returns {Promise<string>}
	 */
	async __resolveWorkspace(agentId) {
		const result = await this.__gatewayRpc('agents.files.list', { agentId }, { timeoutMs: 5000 });
		if (!result?.ok) {
			const err = new Error(result?.error ?? 'Failed to resolve workspace');
			err.code = 'AGENT_DENIED';
			throw err;
		}
		const workspace = result?.response?.payload?.workspace;
		if (!workspace) {
			const err = new Error(`No workspace for agent: ${agentId}`);
			err.code = 'AGENT_DENIED';
			throw err;
		}
		return workspace;
	}

	/**
	 * 列出所有 agent 的 workspace 路径（供临时文件清理使用）
	 * @returns {Promise<string[]>}
	 */
	async __listAgentWorkspaces() {
		const listResult = await this.__gatewayRpc('agents.list', {}, { timeoutMs: 3000 });
		let agentIds = ['main'];
		if (listResult?.ok === true && Array.isArray(listResult?.response?.payload?.agents)) {
			const ids = listResult.response.payload.agents
				.map((a) => a?.id)
				.filter((id) => typeof id === 'string' && id.trim());
			if (ids.length > 0) agentIds = ids;
		}
		const workspaces = [];
		for (const id of agentIds) {
			try {
				const ws = await this.__resolveWorkspace(id);
				workspaces.push(ws);
			} catch (err) {
				this.__logDebug(`workspace resolve failed for agent=${id}: ${err?.message}`);
			}
		}
		return workspaces;
	}

	/* c8 ignore stop */

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
					version: this.__pluginVersion ?? 'unknown',
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
		catch (err) {
			this.logger.warn?.(`[coclaw] gateway connect request failed: ${String(err?.message ?? err)}`);
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
					remoteLog('ws.connected peer=gateway');
					this.__logDebug(`gateway connect ok <- id=${payload.id}`);
					this.gatewayConnectReqId = null;
					this.__ensureSessionsPromise = this.__ensureAllAgentSessions();
					this.__pushInstanceName();
				}
				else {
					this.gatewayReady = false;
					this.gatewayConnectReqId = null;
					remoteLog(`ws.connect-failed peer=gateway msg=${payload?.error?.message ?? 'unknown'}`);
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
				this.webrtcPeer?.broadcast(payload);
			}
		});

		ws.addEventListener('open', () => {
			this.__logDebug('gateway ws open, waiting for connect.challenge');
		});
		ws.addEventListener('close', (ev) => {
			remoteLog(`ws.disconnected peer=gateway code=${ev?.code ?? '?'}`);
			this.logger.info?.(`[coclaw] gateway ws closed (code=${ev?.code ?? '?'} reason=${ev?.reason ?? 'n/a'})`);
			this.gatewayWs = null;
			this.gatewayReady = false;
			this.gatewayConnectReqId = null;
			/* c8 ignore next 3 -- gateway 意外断开时结算未完成 RPC，避免等超时 */
			for (const [, settle] of this.gatewayPendingRequests) {
				settle({ ok: false, error: 'gateway_closed' });
			}
			this.gatewayPendingRequests.clear();
		});
		ws.addEventListener('error', (err) => {
			/* c8 ignore next -- ?./?? fallback */
			remoteLog(`ws.error peer=gateway msg=${String(err?.message ?? err)}`);
			this.logger.warn?.(`[coclaw] gateway ws error: ${String(err?.message ?? err)}`);
		});
	}

	async __waitGatewayReady(timeoutMs = this.__gatewayReadyTimeoutMs) {
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

	async __handleGatewayRequestFromDc(payload) {
		const ready = await this.__waitGatewayReady();
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
			this.__logDebug(`gateway req drop (offline): id=${payload.id} method=${payload.method}`);
			this.webrtcPeer?.broadcast({
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
			this.webrtcPeer?.broadcast({
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
		remoteLog(`ws.reconnecting peer=server delay=${RECONNECT_MS}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.__connectIfNeeded().catch((err) => {
				/* c8 ignore next -- 防御性兜底，__connectIfNeeded 内部已有完整错误处理 */
				this.logger.warn?.(`[coclaw] reconnect failed: ${err?.message}`);
			});
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
			remoteLog('ws.connect-timeout peer=server');
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
			remoteLog('ws.connected peer=server');
			setRemoteLogSender((msg) => {
				if (sock.readyState === 1) sock.send(JSON.stringify(msg));
			});
			this.__startServerHeartbeat(sock);
			this.__ensureGatewayConnection();
		});

		sock.addEventListener('message', async (event) => {
			this.__resetServerHbTimeout(sock);
			try {
				const payload = JSON.parse(String(event.data ?? '{}'));
				if (payload?.type === 'claw.unbound') {
					remoteLog('ws.claw-unbound');
					await this.__clearTokenLocal(payload.clawId);
					try { sock.close(4001, 'claw_unbound'); }
					/* c8 ignore next */
					catch {}
					return;
				}
				if (payload?.type?.startsWith('rtc:')) {
					try {
						if (!this.__webrtcPeerReady) {
							this.__webrtcPeerReady = this.__initWebrtcPeer().catch((err) => {
								this.__webrtcPeerReady = null;
								throw err;
							});
						}
						await this.__webrtcPeerReady;
						await this.webrtcPeer.handleSignaling(payload);
					} catch (err) {
						this.logger.warn?.(`[coclaw/rtc] signaling error (or werift not found): ${err?.message}`);
						remoteLog(`rtc.signaling-error msg=${err?.message}`);
					}
					return;
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
			setRemoteLogSender(null);
			const wasIntentional = this.intentionallyClosed;
			this.serverWs = null;
			this.intentionallyClosed = false;
			this.__closeGatewayWs();
			if (this.webrtcPeer) {
				try { await this.webrtcPeer.closeAll(); }
				/* c8 ignore next 3 -- 防御性兜底，werift close 异常时不可崩溃 gateway */
				catch (e) { this.logger.warn?.(`[coclaw/rtc] closeAll failed: ${e?.message}`); }
				this.webrtcPeer = null;
				this.__webrtcPeerReady = null;
			}
			if (this.__fileHandler) {
				this.__fileHandler.cancelCleanup();
				this.__fileHandler = null;
			}

			if (event?.code === 4001 || event?.code === 4003) {
				remoteLog(`ws.auth-close peer=server code=${event.code}`);
				this.logger.warn?.(`[coclaw] server ws auth-close (code=${event.code}), clearing local token`);
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
				remoteLog(`ws.disconnected peer=server code=${event?.code ?? 'unknown'} reason=${event?.reason ?? 'n/a'}`);
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
			setRemoteLogSender(null);
			remoteLog(`ws.error peer=server msg=${String(err?.message ?? err)}`);
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
		// 先完成 WebRTC 实现加载，再建立连接，避免 UI 发来 offer 时 RTC 包未就绪
		const preloadFn = this.__preloadNdc
			?? (await import('./webrtc/ndc-preloader.js')).preloadNdc;
		// 版本预热与 preload 并行，供 gateway connect 请求同步使用
		const [preloadResult] = await Promise.all([
			preloadFn().catch((err) => {
				// preloadNdc 设计上永不 throw，此 catch 为纯防御性兜底
				this.logger.warn?.(`[coclaw] ndc preload unexpected failure: ${err?.message}`);
				return { PeerConnection: null, cleanup: null, impl: 'none' };
			}),
			getPluginVersion()
				.then((v) => { this.__pluginVersion = v; })
				.catch(() => { this.__pluginVersion = 'unknown'; }),
		]);
		// 竞态保护：若 preload 期间 stop() 已执行，不再赋值，直接返回。
		// 不调 cleanup()——与 stop() 策略一致，native threads 保持活跃供后续复用。
		if (!this.started) {
			return;
		}
		this.__ndcPreloadResult = preloadResult;
		this.__ndcCleanup = preloadResult.cleanup;
		const implLabel = preloadResult.impl === 'ndc' ? 'node-datachannel(ndc)' : preloadResult.impl;
		this.logger.info?.(`[coclaw] WebRTC impl: ${implLabel}`);
		remoteLog(`bridge.webrtc-impl impl=${implLabel}`);
		remoteLog(`bridge.started version=${this.__pluginVersion}`);
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
		setRemoteLogSender(null);
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
			this.__webrtcPeerReady = null;
		}
		// 不在 stop() 中调用 ndc.cleanup()：
		// cleanup() 是同步 native 调用，需 join native threads，耗时 10s+，
		// 会阻塞事件循环导致 RPC handler 超时。
		// gateway 是长驻进程，native threads 保持活跃即可；
		// 下次 start() 重新 import（ESM 缓存命中）可直接复用。
		// 进程退出时 OS 会回收所有资源。
		this.__ndcCleanup = null;
		this.__ndcPreloadResult = null;
		if (this.__fileHandler) {
			this.__fileHandler.cancelCleanup();
			this.__fileHandler = null;
		}
		const sock = this.serverWs;
		if (sock) {
			this.intentionallyClosed = true;
			this.serverWs = null;
			// 等待 WebSocket 真正关闭，避免残留连接收到 claw.unbound 等消息
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
	const deps = opts?.__deps; // 仅测试用
	singleton = new RealtimeBridge(deps);
	await singleton.start(opts);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.forceCleanup] - 调用 ndc cleanup() 释放 native TSFN（仅测试用）。
 *   生产环境不调用：cleanup() 会 join native threads（无活跃 PC 时通常 sub-second，
 *   但 worst-case 阻塞 10s），且 gateway 通过 process.exit() 退出无需依赖事件循环排空。
 */
export async function stopRealtimeBridge({ forceCleanup = false } = {}) {
	if (!singleton) {
		return;
	}
	const cleanupFn = forceCleanup ? singleton.__ndcCleanup : null;
	await singleton.stop();
	singleton = null; // 置 null 后须通过 restartRealtimeBridge 重建
	if (typeof cleanupFn === 'function') {
		try { cleanupFn(); } catch { /* c8 ignore next -- cleanup 失败不影响 stop 结果 */ }
	}
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

/**
 * 广播插件自发事件（推送到 server + 广播到所有 UI DC）
 * @param {string} event - 事件名（如 'coclaw.info.updated'）
 * @param {object} [payload]
 */
export function broadcastPluginEvent(event, payload) {
	if (!singleton) return;
	const frame = { type: 'event', event, payload };
	singleton.__forwardToServer(frame);
	singleton.webrtcPeer?.broadcast(frame);
}
