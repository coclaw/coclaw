/* c8 ignore start */
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { clearConfig, getBindingsPath, readConfig } from './config.js';
import { getRuntime } from './runtime.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_GATEWAY_WS_URL = 'ws://127.0.0.1:18789';
const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

let serverWs = null;
let gatewayWs = null;
let reconnectTimer = null;
let connectTimer = null;
let started = false;
let gatewayReady = false;
let gatewayConnectReqId = null;
let gatewayRpcSeq = 0;
const gatewayPendingRequests = new Map();
let mainSessionEnsurePromise = null;
let mainSessionEnsured = false;

function logBridgeDebug(message) {
	if (typeof currentLogger?.debug === 'function') {
		currentLogger.debug(`[coclaw] ${message}`);
	}
}
let currentLogger = console;
let currentPluginConfig = {};
let intentionallyClosed = false;

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

function resolveGatewayWsUrl() {
	return currentPluginConfig?.gatewayWsUrl
		?? process.env.COCLAW_GATEWAY_WS_URL
		?? DEFAULT_GATEWAY_WS_URL;
}

async function clearTokenLocal() {
	const cfg = await readConfig();
	if (!cfg?.token) {
		return;
	}
	await clearConfig();
}

function closeGatewayWs() {
	if (!gatewayWs) {
		return;
	}
	try {
		gatewayWs.close(1000, 'server-disconnect');
	}
	catch {}
	gatewayWs = null;
	gatewayReady = false;
	gatewayConnectReqId = null;
	for (const [, settle] of gatewayPendingRequests) {
		settle({ ok: false, error: 'gateway_closed' });
	}
	gatewayPendingRequests.clear();
}

function forwardToServer(payload) {
	if (!serverWs || serverWs.readyState !== 1) {
		return;
	}
	try {
		serverWs.send(JSON.stringify(payload));
	}
	catch {}
}

function resolveGatewayAuthToken() {
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

function nextGatewayReqId(prefix = 'coclaw-rpc') {
	gatewayRpcSeq += 1;
	return `${prefix}-${Date.now()}-${gatewayRpcSeq}`;
}

async function gatewayRpc(method, params = {}, options = {}) {
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
	const ready = await waitGatewayReady(timeoutMs);
	if (!ready || !gatewayWs || gatewayWs.readyState !== 1 || !gatewayReady) {
		return { ok: false, error: 'gateway_not_ready' };
	}
	const ws = gatewayWs;
	const id = nextGatewayReqId('coclaw-gw');
	return await new Promise((resolve) => {
		let finished = false;
		const settle = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			gatewayPendingRequests.delete(id);
			resolve(result);
		};
		gatewayPendingRequests.set(id, settle);
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
		catch {
			settle({ ok: false, error: 'send_failed' });
		}
	});
}

// eslint-disable-next-line no-unused-vars -- 功能暂时禁用，保留函数体供后续修复参考
async function ensureMainSessionKey() {
	if (mainSessionEnsured) {
		return { ok: true, state: 'ready' };
	}
	if (mainSessionEnsurePromise) {
		return await mainSessionEnsurePromise;
	}
	mainSessionEnsurePromise = (async () => {
		const key = 'agent:main:main';
		const resolved = await gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
		const resolvedSessionId = resolved?.response?.result?.entry?.sessionId;
		if (resolved?.ok === true && typeof resolvedSessionId === 'string' && resolvedSessionId.trim()) {
			mainSessionEnsured = true;
			logBridgeDebug(`main session key ensure: ready key=${key} sessionId=${resolvedSessionId}`);
			return { ok: true, state: 'ready', sessionId: resolvedSessionId };
		}
		const reset = await gatewayRpc('sessions.reset', { key, reason: 'new' }, { timeoutMs: 2500 });
		if (reset?.ok !== true) {
			return { ok: false, error: reset?.error ?? 'sessions_reset_failed' };
		}
		const verify = await gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
		const verifySessionId = verify?.response?.result?.entry?.sessionId;
		if (verify?.ok === true && typeof verifySessionId === 'string' && verifySessionId.trim()) {
			mainSessionEnsured = true;
			logBridgeDebug(`main session key ensure: created key=${key} sessionId=${verifySessionId}`);
			return { ok: true, state: 'created', sessionId: verifySessionId };
		}
		return { ok: false, error: verify?.error ?? 'sessions_resolve_after_reset_failed' };
	})();
	try {
		const result = await mainSessionEnsurePromise;
		if (!result?.ok) {
			currentLogger.warn?.(`[coclaw] ensure main session key failed: ${result?.error ?? 'unknown'}`);
		}
		return result;
	}
	finally {
		mainSessionEnsurePromise = null;
	}
}

function sendGatewayConnectRequest(ws) {
	gatewayConnectReqId = `coclaw-connect-${Date.now()}`;
	logBridgeDebug(`gateway connect request -> id=${gatewayConnectReqId}`);
	const authToken = resolveGatewayAuthToken();
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
			id: gatewayConnectReqId,
			method: 'connect',
			params,
		}));
	}
	catch {
		gatewayConnectReqId = null;
	}
}

function ensureGatewayConnection() {
	if (gatewayWs || !serverWs || serverWs.readyState !== 1) {
		return;
	}
	const WebSocketCtor = globalThis.WebSocket;
	if (!WebSocketCtor) {
		return;
	}
	const ws = new WebSocketCtor(resolveGatewayWsUrl());
	gatewayWs = ws;
	gatewayReady = false;
	gatewayConnectReqId = null;

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
			logBridgeDebug('gateway event <- connect.challenge');
			sendGatewayConnectRequest(ws);
			return;
		}
		if (payload.type === 'res' && gatewayConnectReqId && payload.id === gatewayConnectReqId) {
			if (payload.ok === true) {
				gatewayReady = true;
				logBridgeDebug(`gateway connect ok <- id=${payload.id}`);
				gatewayConnectReqId = null;
				// [DISABLED] ensureMainSessionKey 存在 bug，每次重连都会误触 sessions.reset
				// 导致对话被频繁重置。详见 docs/ensure-main-session-bug-analysis.md
				// void ensureMainSessionKey();
			}
			else {
				gatewayReady = false;
				gatewayConnectReqId = null;
				currentLogger.warn?.(`[coclaw] gateway connect failed: ${payload?.error?.message ?? 'unknown'}`);
				try {
					ws.close(1008, 'gateway_connect_failed');
				}
				catch {}
			}
			return;
		}
		if (payload.type === 'res' && typeof payload.id === 'string') {
			const settle = gatewayPendingRequests.get(payload.id);
			if (settle) {
				settle({
					ok: payload.ok === true,
					response: payload,
					error: payload?.error?.message ?? payload?.error?.code,
				});
				return;
			}
		}
		if (!gatewayReady) {
			return;
		}
		if (payload.type === 'res' || payload.type === 'event') {
			forwardToServer(payload);
		}
	});

	ws.addEventListener('open', () => {
		// wait for connect.challenge
	});
	ws.addEventListener('close', () => {
		gatewayWs = null;
		gatewayReady = false;
		gatewayConnectReqId = null;
	});
	ws.addEventListener('error', () => {});
}

async function waitGatewayReady(timeoutMs = 1500) {
	ensureGatewayConnection();
	if (gatewayWs && gatewayWs.readyState === 1 && gatewayReady) {
		return true;
	}
	const ws = gatewayWs;
	if (!ws) {
		return false;
	}
	return await new Promise((resolve) => {
		let done = false;
		const finish = (ok) => {
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
		const onError = () => finish(false);
		const onClose = () => finish(false);
		const poller = setInterval(() => {
			if (gatewayWs !== ws) {
				finish(false);
				return;
			}
			if (gatewayReady && ws.readyState === 1) {
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

async function handleGatewayRequestFromServer(payload) {
	const ready = await waitGatewayReady();
	if (!ready || !gatewayWs || gatewayWs.readyState !== 1) {
		logBridgeDebug(`gateway req drop (offline): id=${payload.id} method=${payload.method}`);
		forwardToServer({
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
		logBridgeDebug(`gateway req -> id=${payload.id} method=${payload.method}`);
		gatewayWs.send(JSON.stringify({
			type: 'req',
			id: payload.id,
			method: payload.method,
			params: payload.params ?? {},
		}));
	}
	catch {
		forwardToServer({
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

function clearConnectTimer() {
	if (!connectTimer) {
		return;
	}
	clearTimeout(connectTimer);
	connectTimer = null;
}

function scheduleReconnect() {
	if (!started || reconnectTimer) {
		return;
	}
	reconnectTimer = setTimeout(async () => {
		reconnectTimer = null;
		await connectIfNeeded();
	}, RECONNECT_MS);
	reconnectTimer.unref?.();
}

async function connectIfNeeded() {
	if (!started || serverWs) {
		return;
	}

	const bindingsPath = getBindingsPath();
	const cfg = await readConfig();
	if (!cfg?.token) {
		currentLogger.warn?.(`[coclaw] realtime bridge skip connect: missing token in ${bindingsPath}`);
		return;
	}

	const baseUrl = currentPluginConfig?.serverUrl ?? cfg.serverUrl ?? process.env.COCLAW_SERVER_URL ?? DEFAULT_SERVER_URL;
	const target = toServerWsUrl(baseUrl, cfg.token);
	const WebSocketCtor = globalThis.WebSocket;
	if (!WebSocketCtor) {
		currentLogger.warn?.('[coclaw] WebSocket not available, skip realtime bridge');
		return;
	}

	const maskedTarget = maskUrlToken(target);
	currentLogger.info?.(`[coclaw] realtime bridge connecting: ${maskedTarget} (cfg: ${bindingsPath})`);
	intentionallyClosed = false;
	const sock = new WebSocketCtor(target);
	serverWs = sock;
	clearConnectTimer();
	connectTimer = setTimeout(() => {
		if (serverWs !== sock || intentionallyClosed) {
			return;
		}
		currentLogger.warn?.(`[coclaw] realtime bridge connect timeout, will retry: ${maskedTarget}`);
		serverWs = null;
		closeGatewayWs();
		scheduleReconnect();
		try {
			sock.close(4000, 'connect_timeout');
		}
		catch {}
	}, CONNECT_TIMEOUT_MS);
	connectTimer.unref?.();

	sock.addEventListener('open', () => {
		clearConnectTimer();
		currentLogger.info?.(`[coclaw] realtime bridge connected: ${maskedTarget}`);
		ensureGatewayConnection();
	});

	sock.addEventListener('message', async (event) => {
		try {
			const payload = JSON.parse(String(event.data ?? '{}'));
			if (payload?.type === 'bot.unbound') {
				await clearTokenLocal();
				try {
					sock.close(4001, 'bot_unbound');
				}
				catch {}
				return;
			}
			if (payload?.type === 'req' || payload?.type === 'rpc.req') {
				void handleGatewayRequestFromServer({
					id: payload.id,
					method: payload.method,
					params: payload.params ?? {},
				});
			}
		}
		catch (err) {
			currentLogger.warn?.(`[coclaw] realtime message parse failed: ${String(err?.message ?? err)}`);
		}
	});

	sock.addEventListener('close', async (event) => {
		clearConnectTimer();
		// 若 serverWs 已指向新实例（如 refresh 后），跳过旧 sock 的清理
		if (serverWs !== null && serverWs !== sock) {
			return;
		}
		const wasIntentional = intentionallyClosed;
		serverWs = null;
		intentionallyClosed = false;
		closeGatewayWs();

		if (event?.code === 4001 || event?.code === 4003) {
			await clearTokenLocal();
			return;
		}

		if (!wasIntentional) {
			currentLogger.warn?.(`[coclaw] realtime bridge closed (${event?.code ?? 'unknown'}: ${event?.reason ?? 'n/a'}), will retry in ${RECONNECT_MS}ms`);
			scheduleReconnect();
		}
	});

	sock.addEventListener('error', (err) => {
		if (serverWs !== sock || intentionallyClosed) {
			return;
		}
		clearConnectTimer();
		currentLogger.warn?.(`[coclaw] realtime bridge error, will retry in ${RECONNECT_MS}ms: ${String(err?.message ?? err)}`);
		serverWs = null;
		closeGatewayWs();
		scheduleReconnect();
		try {
			sock.close(4000, 'connect_error');
		}
		catch {}
	});
}

export async function startRealtimeBridge({ logger, pluginConfig } = {}) {
	currentLogger = logger ?? console;
	currentPluginConfig = pluginConfig ?? {};
	started = true;
	await connectIfNeeded();
}

export async function refreshRealtimeBridge() {
	// 停止再启动，确保用新 token 重连
	await stopRealtimeBridge();
	await startRealtimeBridge({
		logger: currentLogger,
		pluginConfig: currentPluginConfig,
	});
}

export async function stopRealtimeBridge() {
	started = false;
	clearConnectTimer();
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	closeGatewayWs();
	if (serverWs) {
		intentionallyClosed = true;
		try {
			serverWs.close(1000, 'stopped');
		}
		catch {}
		serverWs = null;
	}
}
/* c8 ignore stop */
