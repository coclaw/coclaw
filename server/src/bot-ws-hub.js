import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { findBotById, findBotByTokenHash, updateBotName } from './repos/bot.repo.js';
import { genTurnCreds } from './routes/turn.route.js';

const botSockets = new Map();
const uiSockets = new Map();
const uiTickets = new Map();
const botRpcPending = new Map();
let wsServer = null;
let wsSessionMiddleware = null;
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

function rtcLogInfo(msg) { console.info(`[coclaw/rtc] ${msg}`); }
function rtcLogWarn(msg) { console.warn(`[coclaw/rtc] ${msg}`); }
function rtcLogDebug(msg) { if (WS_VERBOSE) console.debug(`[coclaw/rtc] ${msg}`); }

function getWebSocketCloseCode(reason) {
	if (reason === 'bot_unbound') {
		return 4001;
	}
	if (reason === 'token_revoked') {
		return 4002;
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
		botStatusEmitter.emit('nameUpdated', { botId: key, name: latestName });
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

async function authenticateUiSession(req) {
	if (!wsSessionMiddleware) {
		return null;
	}
	const url = new URL(req.url ?? '', 'http://localhost');
	const botId = url.searchParams.get('botId');
	if (!botId) {
		return null;
	}
	try {
		// session 中间件需要最小 res stub；WS upgrade 时不会触发 res.end/writeHead
		const stubRes = { on() { return this; }, end() {}, write() {}, writeHead() {}, setHeader() {}, getHeader() {} };
		await new Promise((resolve, reject) => {
			wsSessionMiddleware(req, stubRes, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}
	catch {
		return null;
	}
	const userId = req.session?.passport?.user;
	if (!userId) {
		return null;
	}
	let bot = null;
	try {
		bot = await findBotById(BigInt(botId));
	}
	catch {
		return null;
	}
	if (!bot || String(bot.userId) !== String(userId)) {
		return null;
	}
	return { ok: true, botId: String(bot.id), userId: String(userId) };
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

function findUiSocketByConnId(botId, connId) {
	const set = uiSockets.get(botId);
	if (!set) return null;
	for (const ws of set) {
		if (ws.connId === connId && ws.readyState === 1) return ws;
	}
	return null;
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

	// 应用层心跳：直接回 pong，不转发给 UI
	if (payload.type === 'ping') {
		try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
		return;
	}

	// WebRTC 信令：Plugin → 定向投递到指定 UI socket
	if (payload.type === 'rtc:answer' || payload.type === 'rtc:ice' || payload.type === 'rtc:closed') {
		const target = findUiSocketByConnId(botId, payload.toConnId);
		if (target) {
			try { target.send(JSON.stringify(payload)); } catch {}
			if (payload.type === 'rtc:answer') rtcLogInfo(`rtc:answer routed to connId=${payload.toConnId}`);
			else rtcLogDebug(`${payload.type} routed to connId=${payload.toConnId}`);
		} else {
			rtcLogWarn(`rtc target not found botId=${botId} connId=${payload.toConnId}`);
		}
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
	// 应用层心跳：直接回 pong，不转发给 bot
	if (payload.type === 'ping') {
		try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
		return;
	}

	// WebRTC 信令：UI → 转发到 bot，附上 fromConnId
	if (payload.type === 'rtc:offer' || payload.type === 'rtc:ice' || payload.type === 'rtc:ready' || payload.type === 'rtc:closed') {
		payload.fromConnId = ws.connId;
		if (payload.type === 'rtc:offer' && process.env.TURN_SECRET) {
			payload.turnCreds = genTurnCreds(String(botId), process.env.TURN_SECRET);
		}
		const sent = forwardToBot(botId, payload);
		if (!sent) {
			rtcLogDebug(`rtc message dropped, bot offline botId=${botId} type=${payload.type}`);
		} else {
			if (payload.type === 'rtc:offer') rtcLogInfo(`rtc:offer forwarded bot=${botId} connId=${ws.connId}`);
			else rtcLogDebug(`${payload.type} forwarded bot=${botId} connId=${ws.connId}`);
		}
		return;
	}

	const normalized = payload.type === 'rpc.req'
		? { type: 'req', id: payload.id, method: payload.method, params: payload.params ?? {} }
		: payload;
	wsLogDebug(`ui->server req id=${normalized.id ?? 'n/a'} method=${normalized.method ?? 'n/a'}`);
	// 临时诊断：记录 agent 请求的附件信息
	if (normalized.method === 'agent' && normalized.params?.attachments?.length) {
		const atts = normalized.params.attachments;
		const info = atts.map((a) => `${a.fileName ?? '?'}(${a.mimeType ?? '?'},${Math.round((a.content?.length ?? 0) * 3 / 4 / 1024)}KB)`);
		wsLogInfo(`ui->server agent attachments: count=${atts.length} ${info.join(', ')} rawBytes=${String(raw).length}`);
	}
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

/**
 * 清理过期的 UI WS ticket，防止未消费 ticket 累积泄漏。
 * 提取为独立函数便于单元测试。
 */
export function pruneUiTickets() {
	const now = Date.now();
	for (const [key, info] of uiTickets) {
		if (info.expiresAt < now) uiTickets.delete(key);
	}
}

export function attachBotWsHub(httpServer, { sessionMiddleware } = {}) {
	wsSessionMiddleware = sessionMiddleware ?? null;
	wsServer = new WebSocketServer({ noServer: true });

	const ticketPruneInterval = setInterval(pruneUiTickets, 5 * 60_000);
	ticketPruneInterval.unref();

	httpServer.on('upgrade', async (req, socket, head) => {
		try {
			const url = new URL(req.url ?? '', 'http://localhost');
			if (url.pathname !== '/api/v1/bots/stream') {
				return;
			}

			const role = url.searchParams.get('role') ?? 'bot';
			let auth;
			if (role === 'ui') {
				// session cookie 优先，ticket 兜底
				auth = await authenticateUiSession(req);
				if (!auth?.ok) {
					auth = authenticateUiTicket(req);
				}
			}
			else {
				auth = await authenticateBotRequest(req);
			}
			if (!auth.ok) {
				wsLogWarn(`ws auth failed role=${role} code=${auth.code} message=${auth.message}`);
				socket.write(`HTTP/1.1 ${auth.code} Unauthorized\r\n\r\n`);
				socket.destroy();
				return;
			}

			const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
				|| req.socket?.remoteAddress
				|| 'unknown';

			wsServer.handleUpgrade(req, socket, head, (ws) => {
				const botId = auth.botId;
				if (role === 'ui') {
					registerSocket(uiSockets, botId, ws);
					ws.connId = 'c_' + crypto.randomBytes(4).toString('hex');
					wsLogInfo(`ui ws connected botId=${botId} userId=${auth.userId ?? 'n/a'} ip=${remoteIp} connId=${ws.connId}`);
					ws.on('message', (raw) => onUiMessage(botId, ws, raw));
					// UI 侧不做协议级心跳：由 UI 客户端自行维护应用层心跳，
					// 避免大消息传输时 server 误 terminate UI 连接
					ws.on('close', (code, reason) => {
						unregisterSocket(uiSockets, botId, ws);
						wsLogInfo(`ui ws disconnected botId=${botId} code=${code} reason=${String(reason || '')}`);
					});
					return;
				}

				const wasOffline = !botSockets.has(botId);
				// 淘汰同 botId 的旧连接（避免半开连接残留）
				const staleSet = botSockets.get(botId);
				if (staleSet && staleSet.size > 0) {
					const stale = [...staleSet];
					for (const old of stale) {
						wsLogInfo(`closing stale bot ws for botId=${botId}`);
						try { old.terminate(); } catch {}
					}
				}
				registerSocket(botSockets, botId, ws);
				wsLogInfo(`bot ws connected botId=${botId} ip=${remoteIp}`);
				if (wasOffline) {
					wsLogInfo(`bot online botId=${botId}`);
				}
				botStatusEmitter.emit('status', { botId, online: true });
				void refreshBotName(botId).catch(() => {});
				ws.on('message', (raw) => onBotMessage(botId, ws, raw));
				// WS 协议级心跳：检测半开连接（仅 bot 侧）
				// 45s 间隔，连续 4 次 miss（~180s）才 terminate，与 plugin 侧对齐
				ws.__isAlive = true;
				ws.__pingMissCount = 0;
				ws.on('pong', () => {
					ws.__isAlive = true;
					ws.__pingMissCount = 0;
				});
				const BOT_PING_INTERVAL_MS = 45_000;
				const BOT_PING_MAX_MISS = 4;
				const botPingInterval = setInterval(() => {
					const tick = botPingTick({
						isAlive: ws.__isAlive,
						missCount: ws.__pingMissCount,
						bufferedAmount: ws.bufferedAmount,
					}, BOT_PING_MAX_MISS);
					ws.__pingMissCount = tick.missCount;
					if (tick.action === 'ok') {
						ws.__isAlive = false;
						ws.ping();
						return;
					}
					if (tick.action === 'skip') {
						wsLogDebug(`bot ws ping skip (buffered=${ws.bufferedAmount}) botId=${botId}`);
						ws.ping();
						return;
					}
					if (tick.action === 'miss') {
						wsLogDebug(`bot ws ping miss ${ws.__pingMissCount}/${BOT_PING_MAX_MISS} botId=${botId}`);
						ws.ping();
						return;
					}
					// terminate
					clearInterval(botPingInterval);
					wsLogWarn(`bot ws ping timeout after ${ws.__pingMissCount} misses, terminating botId=${botId}`);
					ws.terminate();
				}, BOT_PING_INTERVAL_MS);
				ws.on('close', (code, reason) => {
					clearInterval(botPingInterval);
					unregisterSocket(botSockets, botId, ws);
					rejectAllBotRpcPending(botId);
					wsLogInfo(`bot ws disconnected botId=${botId} code=${code} reason=${String(reason || '')}`);
					if (!botSockets.has(botId)) {
						wsLogInfo(`bot offline botId=${botId}`);
						botStatusEmitter.emit('status', { botId, online: false });
						if (botCloseEffect(code).unbound) {
							broadcastToUi(botId, {
								type: 'bot.unbound',
								botId,
								reason: 'remote_unbind',
								at: new Date().toISOString(),
							});
						}
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

/**
 * Bot 心跳状态机（单轮判定）。
 * 从 attachBotWsHub 内联逻辑中提取，便于单元测试。
 * @param {object} state - { isAlive, missCount, bufferedAmount }
 * @param {number} maxMiss
 * @returns {{ action: 'ok'|'skip'|'miss'|'terminate', missCount: number }}
 */
export function botPingTick(state, maxMiss) {
	if (state.isAlive) {
		return { action: 'ok', missCount: 0 };
	}
	if (state.bufferedAmount > 0) {
		return { action: 'skip', missCount: state.missCount };
	}
	const next = state.missCount + 1;
	if (next < maxMiss) {
		return { action: 'miss', missCount: next };
	}
	return { action: 'terminate', missCount: next };
}

/**
 * 判断 bot WS 关闭时的语义效果。
 * code 4001 = 远程解绑（plugin 侧主动关闭）。
 * code 4002 = token 被撤销（管理员操作）。
 * @param {number} code - WebSocket close code
 * @returns {{ unbound: boolean, tokenRevoked: boolean }}
 */
export function botCloseEffect(code) {
	return {
		unbound: code === 4001,
		tokenRevoked: code === 4002,
	};
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

// 测试辅助导出（仅用于单元测试访问内部状态）
export const __test = { uiSockets, botSockets, onUiMessage, onBotMessage, findUiSocketByConnId };
