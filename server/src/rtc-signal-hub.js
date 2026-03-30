/**
 * RTC 信令 WS Hub
 *
 * 管理 UI 侧信令 WS 连接（/api/v1/rtc/signal），
 * 处理消息路由、TURN 凭证注入。
 * 单一 WS per-tab，承载多个 bot 的 RTC 信令。
 */

import { WebSocketServer } from 'ws';

import { register, remove, removeByWs, lookup } from './rtc-signal-router.js';
import { forwardToBot } from './bot-ws-hub.js';
import { genTurnCreds } from './routes/turn.route.js';
import { findBotById } from './repos/bot.repo.js';

const WS_VERBOSE = process.env.COCLAW_WS_DEBUG === '1';

function sigLogInfo(msg) { console.info(`[coclaw/rtc-sig] ${msg}`); }
function sigLogWarn(msg) { console.warn(`[coclaw/rtc-sig] ${msg}`); }
function sigLogDebug(msg) { if (WS_VERBOSE) console.debug(`[coclaw/rtc-sig] ${msg}`); }

/**
 * 验证 botId 归属 userId
 * @param {string} botId
 * @param {string} userId
 * @param {Function} findBotByIdFn - 可注入，便于测试
 * @returns {Promise<boolean>}
 */
async function validateBotOwnership(botId, userId, findBotByIdFn = findBotById) {
	try {
		const bot = await findBotByIdFn(BigInt(botId));
		return !!bot && String(bot.userId) === String(userId);
	} catch {
		return false;
	}
}

/**
 * 处理单条 WS 消息。
 * @param {object} ws
 * @param {string} userId
 * @param {string|Buffer} raw
 * @param {object} [deps] - 依赖注入（测试用）
 * @param {Function} [deps.findBotByIdFn]
 * @param {Function} [deps.forwardToBotFn]
 */
async function handleMessage(ws, userId, raw, deps = {}) {
	const { findBotByIdFn = findBotById, forwardToBotFn = forwardToBot } = deps;

	let payload;
	try {
		payload = JSON.parse(String(raw ?? '{}'));
	} catch (err) {
		sigLogDebug(`invalid JSON from userId=${userId}: ${err.message}`);
		return;
	}
	if (!payload || typeof payload !== 'object') return;

	const { type } = payload;

	// 心跳
	if (type === 'ping') {
		try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
		return;
	}

	// WS 重连后批量恢复 connId 注册
	if (type === 'signal:resume') {
		const connIds = payload.connIds;
		let count = 0;
		if (connIds && typeof connIds === 'object' && !Array.isArray(connIds)) {
			for (const [botId, connId] of Object.entries(connIds)) {
				const owned = await validateBotOwnership(botId, userId, findBotByIdFn);
				if (!owned) {
					sigLogWarn(`resume: botId=${botId} not owned by userId=${userId}, skipped`);
					continue;
				}
				if (!register(connId, ws, botId, userId)) {
					sigLogWarn(`resume: connId=${connId} occupied by another WS, skipped`);
					continue;
				}
				count++;
			}
		}
		try { ws.send(JSON.stringify({ type: 'signal:resumed' })); } catch {}
		sigLogInfo(`signal:resumed userId=${userId} registered=${count}/${Object.keys(connIds ?? {}).length}`);
		return;
	}

	// RTC 信令：需要 botId + connId
	const { botId, connId } = payload;
	if (!botId || !connId) {
		sigLogDebug(`missing botId/connId in ${type}`);
		return;
	}

	if (type === 'rtc:offer') {
		const owned = await validateBotOwnership(botId, userId, findBotByIdFn);
		if (!owned) {
			sigLogWarn(`rtc:offer denied: botId=${botId} not owned by userId=${userId}`);
			return;
		}
		const ok = register(connId, ws, botId, userId);
		if (!ok) {
			sigLogWarn(`rtc:offer denied: connId=${connId} occupied by another WS`);
			return;
		}
		// 注入 TURN 凭证
		if (process.env.TURN_SECRET) {
			payload.turnCreds = genTurnCreds(String(botId), process.env.TURN_SECRET);
		}
		payload.fromConnId = connId;
		const sent = forwardToBotFn(botId, payload);
		if (sent) {
			sigLogInfo(`rtc:offer forwarded bot=${botId} connId=${connId}`);
		} else {
			sigLogDebug(`rtc:offer dropped, bot offline botId=${botId}`);
		}
		return;
	}

	if (type === 'rtc:ice' || type === 'rtc:ready') {
		let route = lookup(connId);
		// 隐式注册
		if (!route) {
			const owned = await validateBotOwnership(botId, userId, findBotByIdFn);
			if (!owned) {
				sigLogWarn(`${type} denied: botId=${botId} not owned by userId=${userId}`);
				return;
			}
			const ok = register(connId, ws, botId, userId);
			if (!ok) {
				sigLogWarn(`${type} denied: connId=${connId} occupied by another WS`);
				return;
			}
			route = lookup(connId);
		}
		// 防御：register 成功后 lookup 在单线程下必定非 null
		if (!route) {
			sigLogWarn(`${type}: route unexpectedly null after register connId=${connId}`);
			return;
		}
		payload.fromConnId = connId;
		const sent = forwardToBotFn(route.botId, payload);
		if (!sent) {
			sigLogDebug(`${type} dropped, bot offline botId=${route.botId} connId=${connId}`);
		} else {
			sigLogDebug(`${type} forwarded bot=${route.botId} connId=${connId}`);
		}
		return;
	}

	if (type === 'rtc:closed') {
		const route = lookup(connId);
		if (route) {
			payload.fromConnId = connId;
			forwardToBotFn(route.botId, payload);
			sigLogDebug(`rtc:closed forwarded bot=${route.botId} connId=${connId}`);
			remove(connId);
		} else {
			// connId 未注册：需验证 botId 归属后才转发
			if (botId) {
				const owned = await validateBotOwnership(botId, userId, findBotByIdFn);
				if (owned) {
					payload.fromConnId = connId;
					forwardToBotFn(botId, payload);
					sigLogDebug(`rtc:closed forwarded (unregistered) bot=${botId} connId=${connId}`);
				} else {
					sigLogWarn(`rtc:closed denied: botId=${botId} not owned by userId=${userId}`);
				}
			}
			remove(connId); // no-op，但保持语义一致
		}
		return;
	}

	sigLogDebug(`unknown message type: ${type}`);
}

/**
 * 附加 RTC 信令 WS Hub 到 HTTP server。
 * @param {import('http').Server} httpServer
 * @param {{ sessionMiddleware: Function }} options
 */
export function attachRtcSignalHub(httpServer, { sessionMiddleware }) {
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', async (req, socket, head) => {
		try {
			const url = new URL(req.url ?? '', 'http://localhost');
			if (url.pathname !== '/api/v1/rtc/signal') return;

			// 认证：session cookie → userId
			if (!sessionMiddleware) {
				socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
				socket.destroy();
				return;
			}

			const stubRes = { on() { return this; }, end() {}, write() {}, writeHead() {}, setHeader() {}, getHeader() {} };
			try {
				await new Promise((resolve, reject) => {
					sessionMiddleware(req, stubRes, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
			} catch (err) {
				sigLogWarn(`session middleware error: ${err.message}`);
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}

			const userId = req.session?.passport?.user;
			if (!userId) {
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}

			const userIdStr = String(userId);
			const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
				|| req.socket?.remoteAddress
				|| 'unknown';

			wss.handleUpgrade(req, socket, head, (ws) => {
				sigLogInfo(`signal ws connected userId=${userIdStr} ip=${remoteIp}`);
				ws.on('message', (raw) => {
					handleMessage(ws, userIdStr, raw).catch((err) => {
						sigLogWarn(`message handler error userId=${userIdStr}: ${err.message}`);
					});
				});
				ws.on('close', (code, reason) => {
					removeByWs(ws);
					sigLogInfo(`signal ws disconnected userId=${userIdStr} code=${code} reason=${String(reason || '')}`);
				});
			});
		} catch (err) {
			sigLogWarn(`upgrade error: ${err.message}`);
			socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
			socket.destroy();
		}
	});
}

// 测试辅助
export const __test = { handleMessage, validateBotOwnership };
