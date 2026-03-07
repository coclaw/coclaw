import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { findBotById, findBotByTokenHash, updateBotName } from './repos/bot.repo.js';

const botSockets = new Map();
const uiSockets = new Map();
const uiTickets = new Map();
const botRpcPending = new Map();
let wsServer = null;
let botRpcSeq = 1;

export const botStatusEmitter = new EventEmitter();

const WS_VERBOSE = process.env.COCLAW_WS_DEBUG === '1';

function wsLogInfo(message) {
	console.info(`[coclaw/ws] ${message}`);
}

function wsLogWarn(message) {
	console.warn(`[coclaw/ws] ${message}`);
}

function wsLogDebug(message) {
	if (WS_VERBOSE) {
		console.debug(`[coclaw/ws] ${message}`);
	}
}

function getWebSocketCloseCode(reason) {
	if (reason === 'token_revoked' || reason === 'bot_unbound') {
		return 4001;
	}
	if (reason === 'bot_blocked') {
		return 4003;
	}
	return 4000;
}

function registerSocket(map, key, socket) {
	const set = map.get(key) ?? new Set();
	set.add(socket);
	map.set(key, set);
}

function unregisterSocket(map, key, socket) {
	const set = map.get(key);
	if (!set) {
		return;
	}
	set.delete(socket);
	if (set.size === 0) {
		map.delete(key);
	}
}

function getAnyOnlineBotSocket(botId) {
	const set = botSockets.get(String(botId));
	if (!set || set.size === 0) {
		return null;
	}
	for (const ws of set) {
		if (ws.readyState === ws.OPEN) {
			return ws;
		}
	}
	return null;
}

function resolveBotRpcPending(botId, id, payload) {
	const pendingMap = botRpcPending.get(String(botId));
	if (!pendingMap) {
		return false;
	}
	const pending = pendingMap.get(String(id));
	if (!pending) {
		return false;
	}
	clearTimeout(pending.timer);
	pendingMap.delete(String(id));
	if (pendingMap.size === 0) {
		botRpcPending.delete(String(botId));
	}
	pending.resolve(payload);
	return true;
}

function rejectAllBotRpcPending(botId, message = 'bot disconnected') {
	const pendingMap = botRpcPending.get(String(botId));
	if (!pendingMap) {
		return;
	}
	for (const pending of pendingMap.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error(message));
	}
	botRpcPending.delete(String(botId));
}

function requestBotRpc(botId, method, params = {}, timeoutMs = 1000) {
	const key = String(botId);
	const socket = getAnyOnlineBotSocket(key);
	if (!socket) {
		return Promise.resolve(null);
	}
	const id = `server-rpc-${Date.now()}-${botRpcSeq++}`;
	const req = {
		type: 'req',
		id,
		method,
		params,
	};
	return new Promise((resolve, reject) => {
		const pendingMap = botRpcPending.get(key) ?? new Map();
		botRpcPending.set(key, pendingMap);
		const timer = setTimeout(() => {
			pendingMap.delete(id);
			if (pendingMap.size === 0) {
				botRpcPending.delete(key);
			}
			reject(new Error('bot rpc timeout'));
		}, timeoutMs);
		pendingMap.set(id, { resolve, reject, timer });
		try {
			socket.send(JSON.stringify(req));
		}
		catch (err) {
			clearTimeout(timer);
			pendingMap.delete(id);
			if (pendingMap.size === 0) {
				botRpcPending.delete(key);
			}
			reject(err);
		}
	});
}

export async function refreshBotName(botId, { timeoutMs = 1000 } = {}) {
	const key = String(botId);
	let rpcRes = null;
	try {
		rpcRes = await requestBotRpc(key, 'agent.identity.get', {}, timeoutMs);
	}
	catch {
		return undefined;
	}
	if (!rpcRes || rpcRes.ok !== true) {
		return undefined;
	}
	const rawName = typeof rpcRes.payload?.name === 'string'
		? rpcRes.payload.name.trim()
		: '';
	const latestName = rawName || null;
	let bot = null;
	try {
		bot = await findBotById(BigInt(key));
	}
	catch {
		return latestName;
	}
	if (!bot) {
		return latestName;
	}
	const currentName = bot.name ?? null;
	if (currentName !== latestName) {
		await updateBotName(bot.id, latestName).catch(() => {});
	}
	return latestName;
}

async function authenticateBotRequest(req) {
	const url = new URL(req.url ?? '', 'http://localhost');
	const token = url.searchParams.get('token');
	if (!token) {
		return { ok: false, code: 401, message: 'missing token' };
	}

	const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest();
	const bot = await findBotByTokenHash(tokenHash);
	if (!bot) {
		return { ok: false, code: 401, message: 'invalid token' };
	}
	return { ok: true, botId: String(bot.id) };
}

function authenticateUiTicket(req) {
	const url = new URL(req.url ?? '', 'http://localhost');
	const ticket = url.searchParams.get('ticket');
	if (!ticket) {
		return { ok: false, code: 401, message: 'missing ticket' };
	}
	const info = uiTickets.get(ticket);
	if (!info || info.expiresAt < Date.now()) {
		uiTickets.delete(ticket);
		return { ok: false, code: 401, message: 'invalid ticket' };
	}
	uiTickets.delete(ticket);
	return { ok: true, botId: info.botId, userId: info.userId };
}

function broadcastToUi(botId, payload) {
	const set = uiSockets.get(botId);
	if (!set || set.size === 0) {
		return;
	}
	const text = JSON.stringify(payload);
	for (const ws of set) {
		try {
			ws.send(text);
		}
		catch {}
	}
}

function forwardToBot(botId, payload) {
	const set = botSockets.get(botId);
	if (!set || set.size === 0) {
		return false;
	}
	const text = JSON.stringify(payload);
	for (const ws of set) {
		try {
			ws.send(text);
		}
		catch {}
	}
	return true;
}

function onBotMessage(botId, ws, raw) {
	let payload = null;
	try {
		payload = JSON.parse(String(raw ?? '{}'));
	}
	catch {
		return;
	}
	if (!payload || typeof payload !== 'object') {
		return;
	}

	if (payload.type === 'res' || payload.type === 'rpc.res') {
		wsLogDebug(`bot->server res id=${payload.id ?? 'n/a'} ok=${payload.ok !== false}`);
		resolveBotRpcPending(botId, payload.id, payload);
		broadcastToUi(botId, payload.type === 'rpc.res' ? {
			type: 'res',
			id: payload.id,
			ok: payload.ok,
			payload: payload.payload,
			error: payload.error,
		} : payload);
		return;
	}

	if (payload.type === 'event' || payload.type === 'rpc.event') {
		wsLogDebug(`bot->server event=${payload.event ?? 'unknown'}`);
		broadcastToUi(botId, payload.type === 'rpc.event' ? {
			type: 'event',
			event: payload.event,
			payload: payload.payload,
		} : payload);
		return;
	}

	if (payload.type === 'bot.unbound') {
		broadcastToUi(botId, payload);
		try {
			ws.close(4001, 'bot_unbound');
		}
		catch {}
	}
}

function onUiMessage(botId, ws, raw) {
	let payload = null;
	try {
		payload = JSON.parse(String(raw ?? '{}'));
	}
	catch {
		return;
	}
	if (!payload || typeof payload !== 'object') {
		return;
	}
	const normalized = payload.type === 'rpc.req'
		? { type: 'req', id: payload.id, method: payload.method, params: payload.params ?? {} }
		: payload;
	wsLogDebug(`ui->server req id=${normalized.id ?? 'n/a'} method=${normalized.method ?? 'n/a'}`);
	const ok = forwardToBot(botId, normalized);
	if (!ok && normalized?.id) {
		wsLogWarn(`ui req failed: bot offline botId=${botId} id=${normalized.id} method=${normalized.method ?? 'n/a'}`);
		try {
			ws.send(JSON.stringify({
				type: 'res',
				id: normalized.id,
				ok: false,
				error: { code: 'BOT_OFFLINE', message: 'Bot is offline' },
			}));
		}
		catch {}
	}
}

export function listOnlineBotIds() {
	return new Set(botSockets.keys());
}

export function createUiWsTicket({ botId, userId, ttlMs = 60_000 }) {
	const ticket = crypto.randomBytes(16).toString('hex');
	uiTickets.set(ticket, {
		botId: String(botId),
		userId: String(userId),
		expiresAt: Date.now() + ttlMs,
	});
	wsLogDebug(`ui ws ticket issued botId=${String(botId)} userId=${String(userId)} ttlMs=${ttlMs}`);
	return ticket;
}

export function attachBotWsHub(httpServer) {
	wsServer = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', async (req, socket, head) => {
		try {
			const url = new URL(req.url ?? '', 'http://localhost');
			if (url.pathname !== '/api/v1/bots/stream') {
				return;
			}

			const role = url.searchParams.get('role') ?? 'bot';
			const auth = role === 'ui'
				? authenticateUiTicket(req)
				: await authenticateBotRequest(req);
			if (!auth.ok) {
				wsLogWarn(`ws auth failed role=${role} code=${auth.code} message=${auth.message}`);
				socket.write(`HTTP/1.1 ${auth.code} Unauthorized\r\n\r\n`);
				socket.destroy();
				return;
			}

			wsServer.handleUpgrade(req, socket, head, (ws) => {
				const botId = auth.botId;
				if (role === 'ui') {
					registerSocket(uiSockets, botId, ws);
					wsLogInfo(`ui ws connected botId=${botId} userId=${auth.userId ?? 'n/a'}`);
					ws.on('message', (raw) => onUiMessage(botId, ws, raw));
					ws.on('close', () => {
						unregisterSocket(uiSockets, botId, ws);
						wsLogInfo(`ui ws disconnected botId=${botId}`);
					});
					return;
				}

				registerSocket(botSockets, botId, ws);
				wsLogInfo(`bot ws connected botId=${botId}`);
				botStatusEmitter.emit('status', { botId, online: true });
				void refreshBotName(botId).catch(() => {});
				ws.on('message', (raw) => onBotMessage(botId, ws, raw));
				ws.on('close', () => {
					unregisterSocket(botSockets, botId, ws);
					rejectAllBotRpcPending(botId);
					wsLogInfo(`bot ws disconnected botId=${botId}`);
					if (!botSockets.has(botId)) {
						botStatusEmitter.emit('status', { botId, online: false });
					}
				});
			});
		}
		catch {
			socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
			socket.destroy();
		}
	});
}

export function notifyAndDisconnectBot(botId, reason = 'token_revoked') {
	if (!botId) {
		return;
	}
	const key = String(botId);
	const set = botSockets.get(key);
	if (!set || set.size === 0) {
		return;
	}

	wsLogInfo(`notify/disconnect botId=${key} reason=${reason}`);
	const payload = {
		type: 'bot.unbound',
		reason,
		botId: key,
		at: new Date().toISOString(),
	};
	broadcastToUi(key, payload);
	const closeCode = getWebSocketCloseCode(reason);
	for (const ws of set) {
		try {
			ws.send(JSON.stringify(payload));
		}
		catch {}
		try {
			ws.close(closeCode, reason);
		}
		catch {}
	}
}
