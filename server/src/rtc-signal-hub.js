/**
 * RTC 信令 WS Hub
 *
 * 管理 UI 侧信令 WS 连接（/api/v1/rtc/signal），
 * 处理消息路由、TURN 凭证注入。
 * 单一 WS per-tab，承载多个 bot 的 RTC 信令。
 */

import { WebSocketServer } from 'ws';

import { register, remove, removeByWs, lookup } from './rtc-signal-router.js';
import { forwardToBot, fmtLocalTime } from './bot-ws-hub.js';
import { genTurnCreds } from './routes/turn.route.js';
import { findClawById } from './repos/claw.repo.js';

const WS_VERBOSE = process.env.COCLAW_WS_DEBUG === '1';

function sigLogInfo(msg) { console.info(`[coclaw/rtc-sig] ${msg}`); }
function sigLogWarn(msg) { console.warn(`[coclaw/rtc-sig] ${msg}`); }
function sigLogDebug(msg) { if (WS_VERBOSE) console.debug(`[coclaw/rtc-sig] ${msg}`); }

/**
 * 验证 botId 归属 userId
 * @param {string} botId
 * @param {string} userId
 * @param {Function} findClawByIdFn - 可注入，便于测试
 * @returns {Promise<boolean>}
 */
async function validateBotOwnership(botId, userId, findClawByIdFn = findClawById) {
	try {
		const bot = await findClawByIdFn(BigInt(botId));
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
 * @param {Function} [deps.findClawByIdFn]
 * @param {Function} [deps.forwardToBotFn]
 */
async function handleMessage(ws, userId, raw, deps = {}) {
	const { findClawByIdFn = findClawById, forwardToBotFn = forwardToBot } = deps;

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

	// 远程日志：UI 推送诊断信息，透传输出
	if (type === 'log') {
		const logs = payload.logs;
		if (Array.isArray(logs)) {
			for (const entry of logs) {
				if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
					const time = typeof entry.ts === 'number' ? fmtLocalTime(entry.ts) : '??:??:??.???';
					console.info(`[remote][ui][user:${userId}] ${time} | ${entry.text}`);
				}
			}
		}
		return;
	}

	// RTC 信令：需要 botId + connId
	const { botId, connId } = payload;
	if (!botId || !connId) {
		sigLogDebug(`missing botId/connId in ${type}`);
		return;
	}

	if (type === 'rtc:offer') {
		const owned = await validateBotOwnership(botId, userId, findClawByIdFn);
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
			const owned = await validateBotOwnership(botId, userId, findClawByIdFn);
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
			const sent = forwardToBotFn(route.botId, payload);
			if (sent) {
				sigLogDebug(`rtc:closed forwarded bot=${route.botId} connId=${connId}`);
			} else {
				sigLogDebug(`rtc:closed dropped, bot offline botId=${route.botId} connId=${connId}`);
			}
			remove(connId);
		} else {
			// connId 未注册：需验证 botId 归属后才转发
			if (botId) {
				const owned = await validateBotOwnership(botId, userId, findClawByIdFn);
				if (owned) {
					payload.fromConnId = connId;
					const sent = forwardToBotFn(botId, payload);
					if (sent) {
						sigLogDebug(`rtc:closed forwarded (unregistered) bot=${botId} connId=${connId}`);
					} else {
						sigLogDebug(`rtc:closed dropped (unregistered), bot offline botId=${botId} connId=${connId}`);
					}
				} else {
					sigLogWarn(`rtc:closed denied: botId=${botId} not owned by userId=${userId}`);
				}
			}
			remove(connId); // no-op，但保持语义一致
		}
		return;
	}

	sigLogWarn(`unknown message type: ${type} userId=${userId}`);
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
				sigLogWarn('signal ws auth failed: no userId in session');
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
