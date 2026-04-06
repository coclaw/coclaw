import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { findClawById, findClawByTokenHash, updateClawName } from './repos/claw.repo.js';
import { genTurnCredsForGateway } from './routes/turn.route.js';
import { routeToUi, removeByClawId } from './rtc-signal-router.js';

const clawSockets = new Map();
const uiSockets = new Map();
const uiTickets = new Map();
const clawRpcPending = new Map();
/** @type {Map<string, NodeJS.Timeout>} clawId → 延迟 offline timer */
const pendingOffline = new Map();
const CLAW_OFFLINE_GRACE_MS = 5_000;
let wsServer = null;
let wsSessionMiddleware = null;
let clawRpcSeq = 1;

export const clawStatusEmitter = new EventEmitter();

const WS_VERBOSE = process.env.COCLAW_WS_DEBUG === '1';

/** 毫秒时间戳 → 本地时区 HH:mm:ss.SSS */
function fmtLocalTime(ts) {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return '??:??:??.???';
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	const ms = String(d.getMilliseconds()).padStart(3, '0');
	return `${hh}:${mm}:${ss}.${ms}`;
}

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
	if (reason === 'token_revoked' || reason === 'claw_unbound' || reason === 'bot_unbound') {
		return 4001;
	}
	if (reason === 'claw_blocked' || reason === 'bot_blocked') {
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

function getAnyOnlineClawSocket(clawId) {
	const set = clawSockets.get(String(clawId));
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

function resolveClawRpcPending(clawId, id, payload) {
	const pendingMap = clawRpcPending.get(String(clawId));
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
		clawRpcPending.delete(String(clawId));
	}
	pending.resolve(payload);
	return true;
}

function rejectAllClawRpcPending(clawId, message = 'claw disconnected') {
	const pendingMap = clawRpcPending.get(String(clawId));
	if (!pendingMap) {
		return;
	}
	for (const pending of pendingMap.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error(message));
	}
	clawRpcPending.delete(String(clawId));
}

function requestClawRpc(clawId, method, params = {}, timeoutMs = 1000) {
	const key = String(clawId);
	const socket = getAnyOnlineClawSocket(key);
	if (!socket) {
		return Promise.resolve(null);
	}
	const id = `server-rpc-${Date.now()}-${clawRpcSeq++}`;
	const req = {
		type: 'req',
		id,
		method,
		params,
	};
	return new Promise((resolve, reject) => {
		const pendingMap = clawRpcPending.get(key) ?? new Map();
		clawRpcPending.set(key, pendingMap);
		const timer = setTimeout(() => {
			pendingMap.delete(id);
			if (pendingMap.size === 0) {
				clawRpcPending.delete(key);
			}
			reject(new Error('claw rpc timeout'));
		}, timeoutMs);
		pendingMap.set(id, { resolve, reject, timer });
		try {
			socket.send(JSON.stringify(req));
		}
		catch (err) {
			clearTimeout(timer);
			pendingMap.delete(id);
			if (pendingMap.size === 0) {
				clawRpcPending.delete(key);
			}
			reject(err);
		}
	});
}

export async function refreshClawName(clawId, { timeoutMs = 1000 } = {}) {
	const key = String(clawId);
	let rpcRes = null;
	try {
		rpcRes = await requestClawRpc(key, 'agent.identity.get', {}, timeoutMs);
	}
	catch (err) {
		wsLogDebug(`refreshClawName rpc failed clawId=${key}: ${err.message}`);
		return undefined;
	}
	if (!rpcRes || rpcRes.ok !== true) {
		return undefined;
	}
	const rawName = typeof rpcRes.payload?.name === 'string'
		? rpcRes.payload.name.trim()
		: '';
	const latestName = rawName || null;
	let claw = null;
	try {
		claw = await findClawById(BigInt(key));
	}
	catch (err) {
		wsLogWarn(`refreshClawName findClaw failed clawId=${key}: ${err.message}`);
		return latestName;
	}
	if (!claw) {
		return latestName;
	}
	const currentName = claw.name ?? null;
	if (currentName !== latestName) {
		await updateClawName(claw.id, latestName).catch((err) => {
			wsLogWarn(`updateClawName failed clawId=${key}: ${err.message}`);
		});
		clawStatusEmitter.emit('nameUpdated', { clawId: key, name: latestName });
	}
	return latestName;
}

async function authenticateClawRequest(req) {
	const url = new URL(req.url ?? '', 'http://localhost');
	const token = url.searchParams.get('token');
	if (!token) {
		return { ok: false, code: 401, message: 'missing token' };
	}

	const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest();
	const claw = await findClawByTokenHash(tokenHash);
	if (!claw) {
		return { ok: false, code: 401, message: 'invalid token' };
	}
	return { ok: true, clawId: String(claw.id) };
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
	return { ok: true, clawId: info.clawId, userId: info.userId };
}

async function authenticateUiSession(req) {
	if (!wsSessionMiddleware) {
		return null;
	}
	const url = new URL(req.url ?? '', 'http://localhost');
	const clawId = url.searchParams.get('clawId') || url.searchParams.get('botId');
	if (!clawId) {
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
	let claw = null;
	try {
		claw = await findClawById(BigInt(clawId));
	}
	catch {
		return null;
	}
	if (!claw || String(claw.userId) !== String(userId)) {
		return null;
	}
	return { ok: true, clawId: String(claw.id), userId: String(userId) };
}

function broadcastToUi(clawId, payload) {
	const set = uiSockets.get(clawId);
	if (!set || set.size === 0) {
		return;
	}
	const text = JSON.stringify(payload);
	for (const ws of set) {
		try {
			ws.send(text);
		}
		catch (err) {
			wsLogDebug(`broadcastToUi send failed clawId=${clawId}: ${err.message}`);
		}
	}
}

function forwardToClaw(clawId, payload) {
	const set = clawSockets.get(clawId);
	if (!set || set.size === 0) {
		return false;
	}
	const text = JSON.stringify(payload);
	for (const ws of set) {
		try {
			ws.send(text);
		}
		catch (err) {
			wsLogDebug(`forwardToClaw send failed clawId=${clawId}: ${err.message}`);
		}
	}
	return true;
}

function findUiSocketByConnId(clawId, connId) {
	const set = uiSockets.get(clawId);
	if (!set) return null;
	for (const ws of set) {
		if (ws.connId === connId && ws.readyState === 1) return ws;
	}
	return null;
}

function onClawMessage(clawId, ws, raw) {
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

	// 远程日志：plugin 推送诊断信息，透传输出
	if (payload.type === 'log') {
		const logs = payload.logs;
		if (Array.isArray(logs)) {
			for (const entry of logs) {
				if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
					const time = typeof entry.ts === 'number' ? fmtLocalTime(entry.ts) : '??:??:??.???';
					console.info(`[remote][plugin][claw:${clawId}] ${time} | ${entry.text}`);
				}
			}
		}
		return;
	}

	// Plugin 事件：coclaw.info.updated → 持久化 claw name，不转发给 UI
	if (payload.type === 'event' && payload.event === 'coclaw.info.updated') {
		const name = payload.payload?.name || payload.payload?.hostName || null;
		try {
			updateClawName(BigInt(clawId), name).catch((err) => {
				wsLogWarn(`updateClawName from plugin event failed clawId=${clawId}: ${err.message}`);
			});
		}
		catch (err) {
			wsLogWarn(`updateClawName from plugin event failed clawId=${clawId}: ${err.message}`);
		}
		return;
	}

	// WebRTC 信令：Plugin → 定向投递到指定 UI socket
	if (payload.type === 'rtc:answer' || payload.type === 'rtc:ice' || payload.type === 'rtc:closed') {
		// 优先通过新信令路由表投递
		if (routeToUi(payload.toConnId, payload)) {
			rtcLogDebug(`${payload.type} routed via signal-router connId=${payload.toConnId}`);
			return;
		}
		// 旧 per-claw WS fallback
		const target = findUiSocketByConnId(clawId, payload.toConnId);
		if (target) {
			try { target.send(JSON.stringify(payload)); } catch {}
			if (payload.type === 'rtc:answer') rtcLogInfo(`rtc:answer routed to connId=${payload.toConnId}`);
			else rtcLogDebug(`${payload.type} routed to connId=${payload.toConnId}`);
		} else {
			rtcLogWarn(`rtc target not found clawId=${clawId} connId=${payload.toConnId}`);
		}
		return;
	}

	if (payload.type === 'res' || payload.type === 'rpc.res') {
		wsLogDebug(`claw->server res id=${payload.id ?? 'n/a'} ok=${payload.ok !== false}`);
		resolveClawRpcPending(clawId, payload.id, payload);
		broadcastToUi(clawId, payload.type === 'rpc.res' ? {
			type: 'res',
			id: payload.id,
			ok: payload.ok,
			payload: payload.payload,
			error: payload.error,
		} : payload);
		return;
	}

	if (payload.type === 'event' || payload.type === 'rpc.event') {
		wsLogDebug(`claw->server event=${payload.event ?? 'unknown'}`);
		broadcastToUi(clawId, payload.type === 'rpc.event' ? {
			type: 'event',
			event: payload.event,
			payload: payload.payload,
		} : payload);
		return;
	}

	if (payload.type === 'claw.unbound' || payload.type === 'bot.unbound') {
		wsLogInfo(`${payload.type} received clawId=${clawId}`);
		broadcastToUi(clawId, payload);
		const closeReason = payload.type === 'claw.unbound' ? 'claw_unbound' : 'bot_unbound';
		try {
			ws.close(4001, closeReason);
		}
		catch (err) {
			wsLogDebug(`${payload.type} ws.close failed clawId=${clawId}: ${err.message}`);
		}
	}
}

function onUiMessage(clawId, ws, raw) {
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
	// 应用层心跳：直接回 pong，不转发给 claw
	if (payload.type === 'ping') {
		try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
		return;
	}

	// WebRTC 信令：UI → 转发到 claw，附上 fromConnId
	if (payload.type === 'rtc:offer' || payload.type === 'rtc:ice' || payload.type === 'rtc:ready' || payload.type === 'rtc:closed') {
		payload.fromConnId = ws.connId;
		if (payload.type === 'rtc:offer' && process.env.TURN_SECRET) {
			payload.turnCreds = genTurnCredsForGateway(String(clawId), process.env.TURN_SECRET);
		}
		const sent = forwardToClaw(clawId, payload);
		if (!sent) {
			rtcLogDebug(`rtc message dropped, claw offline clawId=${clawId} type=${payload.type}`);
		} else {
			if (payload.type === 'rtc:offer') rtcLogInfo(`rtc:offer forwarded claw=${clawId} connId=${ws.connId}`);
			else rtcLogDebug(`${payload.type} forwarded claw=${clawId} connId=${ws.connId}`);
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
	const ok = forwardToClaw(clawId, normalized);
	if (!ok && normalized?.id) {
		wsLogWarn(`ui req failed: claw offline clawId=${clawId} id=${normalized.id} method=${normalized.method ?? 'n/a'}`);
		try {
			ws.send(JSON.stringify({
				type: 'res',
				id: normalized.id,
				ok: false,
				error: { code: 'CLAW_OFFLINE', message: 'Claw is offline' },
			}));
		}
		catch {}
	}
}

export function listOnlineClawIds() {
	const ids = new Set(clawSockets.keys());
	// grace period 内的 claw 仍视为在线
	for (const clawId of pendingOffline.keys()) {
		ids.add(clawId);
	}
	return ids;
}

export function createUiWsTicket({ clawId, userId, ttlMs = 60_000 }) {
	const ticket = crypto.randomBytes(16).toString('hex');
	uiTickets.set(ticket, {
		clawId: String(clawId),
		userId: String(userId),
		expiresAt: Date.now() + ttlMs,
	});
	wsLogDebug(`ui ws ticket issued clawId=${String(clawId)} userId=${String(userId)} ttlMs=${ttlMs}`);
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

export function attachClawWsHub(httpServer, { sessionMiddleware } = {}) {
	wsSessionMiddleware = sessionMiddleware ?? null;
	wsServer = new WebSocketServer({ noServer: true });

	const ticketPruneInterval = setInterval(pruneUiTickets, 5 * 60_000);
	ticketPruneInterval.unref();

	httpServer.on('upgrade', async (req, socket, head) => {
		try {
			const url = new URL(req.url ?? '', 'http://localhost');
			if (url.pathname !== '/api/v1/bots/stream' && url.pathname !== '/api/v1/claws/stream') {
				return;
			}

			const role = url.searchParams.get('role') ?? 'claw';
			let auth;
			if (role === 'ui') {
				// session cookie 优先，ticket 兜底
				auth = await authenticateUiSession(req);
				if (!auth?.ok) {
					auth = authenticateUiTicket(req);
				}
			}
			else {
				auth = await authenticateClawRequest(req);
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
				const clawId = auth.clawId;
				if (role === 'ui') {
					registerSocket(uiSockets, clawId, ws);
					ws.connId = 'c_' + crypto.randomBytes(4).toString('hex');
					wsLogInfo(`ui ws connected clawId=${clawId} userId=${auth.userId ?? 'n/a'} ip=${remoteIp} connId=${ws.connId}`);
					ws.on('message', (raw) => onUiMessage(clawId, ws, raw));
					// UI 侧不做协议级心跳：由 UI 客户端自行维护应用层心跳，
					// 避免大消息传输时 server 误 terminate UI 连接
					ws.on('close', (code, reason) => {
						unregisterSocket(uiSockets, clawId, ws);
						wsLogInfo(`ui ws disconnected clawId=${clawId} code=${code} reason=${String(reason || '')}`);
					});
					return;
				}

				const wasOffline = !clawSockets.has(clawId);
				// 取消 grace period 的延迟 offline（claw 重连了）
				if (pendingOffline.has(clawId)) {
					clearTimeout(pendingOffline.get(clawId));
					pendingOffline.delete(clawId);
					wsLogInfo(`claw reconnected within grace period clawId=${clawId}`);
				}
				// 淘汰同 clawId 的旧连接（避免半开连接残留）
				const staleSet = clawSockets.get(clawId);
				if (staleSet && staleSet.size > 0) {
					const stale = [...staleSet];
					// 同步清除旧 socket，防止 forwardToClaw 广播到已淘汰的连接
					// （terminate 后的 close 事件是异步的，不能依赖它来移除）
					staleSet.clear();
					for (const old of stale) {
						wsLogInfo(`closing stale claw ws for clawId=${clawId}`);
						try { old.terminate(); } catch {}
					}
				}
				registerSocket(clawSockets, clawId, ws);
				wsLogInfo(`claw ws connected clawId=${clawId} ip=${remoteIp}`);
				if (wasOffline) {
					wsLogInfo(`claw online clawId=${clawId}`);
				}
				clawStatusEmitter.emit('status', { clawId, online: true });
				// TODO: plugin 已通过 coclaw.info.updated 事件主动推送 name，此处拉取待移除
				void refreshClawName(clawId).catch(() => {});
				ws.on('message', (raw) => onClawMessage(clawId, ws, raw));
				// WS 协议级心跳：检测半开连接（仅 claw 侧）
				// 45s 间隔，连续 4 次 miss（~180s）才 terminate，与 plugin 侧对齐
				ws.__isAlive = true;
				ws.__pingMissCount = 0;
				ws.on('pong', () => {
					ws.__isAlive = true;
					ws.__pingMissCount = 0;
				});
				const CLAW_PING_INTERVAL_MS = 45_000;
				const CLAW_PING_MAX_MISS = 4;
				const clawPingInterval = setInterval(() => {
					const tick = clawPingTick({
						isAlive: ws.__isAlive,
						missCount: ws.__pingMissCount,
						bufferedAmount: ws.bufferedAmount,
					}, CLAW_PING_MAX_MISS);
					ws.__pingMissCount = tick.missCount;
					if (tick.action === 'ok') {
						ws.__isAlive = false;
						ws.ping();
						return;
					}
					if (tick.action === 'skip') {
						wsLogDebug(`claw ws ping skip (buffered=${ws.bufferedAmount}) clawId=${clawId}`);
						ws.ping();
						return;
					}
					if (tick.action === 'miss') {
						wsLogDebug(`claw ws ping miss ${ws.__pingMissCount}/${CLAW_PING_MAX_MISS} clawId=${clawId}`);
						ws.ping();
						return;
					}
					// terminate
					clearInterval(clawPingInterval);
					wsLogWarn(`claw ws ping timeout after ${ws.__pingMissCount} misses, terminating clawId=${clawId}`);
					ws.terminate();
				}, CLAW_PING_INTERVAL_MS);
				ws.on('close', (code, reason) => {
					clearInterval(clawPingInterval);
					unregisterSocket(clawSockets, clawId, ws);
					rejectAllClawRpcPending(clawId);
					wsLogInfo(`claw ws disconnected clawId=${clawId} code=${code} reason=${String(reason || '')}`);
					if (!clawSockets.has(clawId)) {
						// 管理性断连（解绑/封禁）立即 offline，不走 grace period
						if (code === 4001 || code === 4003) {
							wsLogInfo(`claw offline clawId=${clawId} (admin close code=${code})`);
							clawStatusEmitter.emit('status', { clawId, online: false });
						}
						else {
							// 延迟发 offline，给 claw 重连留窗口
							if (pendingOffline.has(clawId)) clearTimeout(pendingOffline.get(clawId));
							const timer = setTimeout(() => {
								pendingOffline.delete(clawId);
								// grace 期间可能已重连，再次确认
								if (!clawSockets.has(clawId)) {
									wsLogInfo(`claw offline clawId=${clawId} (after grace)`);
									clawStatusEmitter.emit('status', { clawId, online: false });
								}
							}, CLAW_OFFLINE_GRACE_MS);
							timer.unref();
							pendingOffline.set(clawId, timer);
						}
					}
				});
			});
		}
		catch (err) {
			wsLogWarn(`ws upgrade error: ${err.message}`);
			socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
			socket.destroy();
		}
	});
}

/**
 * Claw 心跳状态机（单轮判定）。
 * 从 attachClawWsHub 内联逻辑中提取，便于单元测试。
 * @param {object} state - { isAlive, missCount, bufferedAmount }
 * @param {number} maxMiss
 * @returns {{ action: 'ok'|'skip'|'miss'|'terminate', missCount: number }}
 */
export function clawPingTick(state, maxMiss) {
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

export function notifyAndDisconnectClaw(clawId, reason = 'token_revoked') {
	if (!clawId) {
		return;
	}
	const key = String(clawId);
	// 清理信令路由表中该 claw 的所有 connId
	removeByClawId(key);
	// 清理可能残留的 grace period timer（网络断开后管理员解绑的场景）
	if (pendingOffline.has(key)) {
		clearTimeout(pendingOffline.get(key));
		pendingOffline.delete(key);
		wsLogInfo(`grace period cancelled by admin disconnect clawId=${key}`);
	}
	const set = clawSockets.get(key);
	if (!set || set.size === 0) {
		return;
	}

	wsLogInfo(`notify/disconnect clawId=${key} reason=${reason}`);
	const clawPayload = {
		type: 'claw.unbound',
		reason,
		clawId: key,
		at: new Date().toISOString(),
	};
	const botPayload = {
		type: 'bot.unbound',
		reason,
		botId: key,
		clawId: key,
		at: new Date().toISOString(),
	};
	// SSE 双事件（先 claw 后 bot）
	broadcastToUi(key, clawPayload);
	broadcastToUi(key, botPayload);
	const closeCode = getWebSocketCloseCode(reason);
	const clawMsg = JSON.stringify(clawPayload);
	const botMsg = JSON.stringify(botPayload);
	for (const ws of set) {
		// 先发双消息，再关闭连接
		try { ws.send(clawMsg); } catch {}
		try { ws.send(botMsg); } catch {}
		try {
			ws.close(closeCode, reason);
		}
		catch (err) {
			wsLogDebug(`notifyAndDisconnectClaw close failed clawId=${key}: ${err.message}`);
		}
	}
}

export { forwardToClaw, fmtLocalTime };

// 测试辅助导出（仅用于单元测试访问内部状态）
export const __test = { uiSockets, clawSockets, uiTickets, pendingOffline, CLAW_OFFLINE_GRACE_MS, getWebSocketCloseCode, onUiMessage, onClawMessage, findUiSocketByConnId, authenticateUiTicket, authenticateUiSession, registerSocket, unregisterSocket, getAnyOnlineClawSocket, resolveClawRpcPending, rejectAllClawRpcPending, requestClawRpc, authenticateClawRequest, broadcastToUi, set wsSessionMiddleware(v) { wsSessionMiddleware = v; }, get wsSessionMiddleware() { return wsSessionMiddleware; } };
