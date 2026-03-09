import { findBotById } from './repos/bot.repo.js';
import { botStatusEmitter } from './bot-ws-hub.js';

// userId(string) -> Set<Response>
const sseClients = new Map();

/**
 * 注册 SSE 客户端
 * @param {string} userId
 * @param {import('express').Response} res
 */
export function registerSseClient(userId, res) {
	const key = String(userId);
	const set = sseClients.get(key) ?? new Set();
	set.add(res);
	sseClients.set(key, set);
	console.info('[coclaw/sse] connected userId=%s clients=%d', key, set.size);

	res.on('close', () => {
		set.delete(res);
		if (set.size === 0) {
			sseClients.delete(key);
		}
		console.info('[coclaw/sse] disconnected userId=%s clients=%d', key, set.size);
	});
}

/**
 * 向指定用户的 SSE 客户端推送数据
 * @param {string} userId
 * @param {object} data
 */
export function sendToUser(userId, data) {
	const key = String(userId);
	const set = sseClients.get(key);
	console.debug('[coclaw/sse] sendToUser userId=%s event=%s clients=%d keys=[%s]', key, data?.event, set?.size ?? 0, [...sseClients.keys()].join(','));
	if (!set || set.size === 0) {
		return;
	}
	const msg = `data: ${JSON.stringify(data)}\n\n`;
	for (const res of set) {
		try {
			res.write(msg);
		}
		catch {}
	}
}

/**
 * 当前是否有 SSE 客户端连接
 */
export function hasSseClients() {
	return sseClients.size > 0;
}

botStatusEmitter.on('status', async ({ botId, online }) => {
	if (!hasSseClients()) {
		return;
	}
	try {
		const bot = await findBotById(BigInt(botId));
		if (!bot) {
			return;
		}
		sendToUser(String(bot.userId), {
			event: 'bot.status',
			botId: String(botId),
			online,
		});
	}
	catch {
		// 静默忽略，避免 SSE 推送失败影响主流程
	}
});

botStatusEmitter.on('nameUpdated', async ({ botId, name }) => {
	if (!hasSseClients()) {
		return;
	}
	try {
		const bot = await findBotById(BigInt(botId));
		if (!bot) {
			return;
		}
		sendToUser(String(bot.userId), {
			event: 'bot.nameUpdated',
			botId: String(botId),
			name,
		});
	}
	catch {
		// 静默忽略
	}
});
