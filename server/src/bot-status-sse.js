import { findBotById, listBotsByUserId } from './repos/bot.repo.js';
import { botStatusEmitter, listOnlineBotIds } from './bot-ws-hub.js';

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
 * 向单个 SSE 客户端推送全量 bot 快照
 * @param {string|bigint} userId
 * @param {import('express').Response} res
 * @param {{ listBotsByUserIdImpl?: Function, listOnlineBotIdsImpl?: Function }} [deps]
 */
export async function sendSnapshot(userId, res, deps = {}) {
	const {
		listBotsByUserIdImpl = listBotsByUserId,
		listOnlineBotIdsImpl = listOnlineBotIds,
	} = deps;
	const bots = await listBotsByUserIdImpl(userId);
	const onlineIds = listOnlineBotIdsImpl();
	const items = bots.map((b) => {
		const botId = b.id.toString();
		return {
			id: botId,
			name: b.name,
			online: onlineIds.has(botId),
			lastSeenAt: b.lastSeenAt,
			createdAt: b.createdAt,
			updatedAt: b.updatedAt,
		};
	});
	const msg = `data: ${JSON.stringify({ event: 'bot.snapshot', items })}\n\n`;
	try {
		res.write(msg);
	} catch (err) {
		console.warn('[coclaw/sse] snapshot write failed userId=%s: %s', userId, err?.message);
	}
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
		catch (err) {
			console.debug('[coclaw/sse] write failed userId=%s: %s', key, err?.message);
		}
	}
}

/**
 * 当前是否有 SSE 客户端连接
 */
export function hasSseClients() {
	return sseClients.size > 0;
}

/**
 * 处理 bot status 变更事件
 * @param {object} param0
 * @param {string} param0.botId
 * @param {boolean} param0.online
 * @param {{ findBotByIdFn?: Function }} [deps]
 */
async function handleStatusEvent({ botId, online }, deps = {}) {
	const { findBotByIdFn = findBotById } = deps;
	if (!hasSseClients()) {
		return;
	}
	try {
		const bot = await findBotByIdFn(BigInt(botId));
		if (!bot) {
			console.debug('[coclaw/sse] status event: bot not found botId=%s (may be deleted)', botId);
			return;
		}
		sendToUser(String(bot.userId), {
			event: 'bot.status',
			botId: String(botId),
			online,
		});
	}
	catch (err) {
		console.warn('[coclaw/sse] status event push failed botId=%s: %s', botId, err?.message);
	}
}

/**
 * 处理 bot 名称变更事件
 * @param {object} param0
 * @param {string} param0.botId
 * @param {string} param0.name
 * @param {{ findBotByIdFn?: Function }} [deps]
 */
async function handleNameUpdatedEvent({ botId, name }, deps = {}) {
	const { findBotByIdFn = findBotById } = deps;
	if (!hasSseClients()) {
		return;
	}
	try {
		const bot = await findBotByIdFn(BigInt(botId));
		if (!bot) {
			console.debug('[coclaw/sse] nameUpdated event: bot not found botId=%s (may be deleted)', botId);
			return;
		}
		sendToUser(String(bot.userId), {
			event: 'bot.nameUpdated',
			botId: String(botId),
			name,
		});
	}
	catch (err) {
		console.warn('[coclaw/sse] nameUpdated event push failed botId=%s: %s', botId, err?.message);
	}
}

botStatusEmitter.on('status', (data) => handleStatusEvent(data));
botStatusEmitter.on('nameUpdated', (data) => handleNameUpdatedEvent(data));

// 测试辅助
export const __test = { handleStatusEvent, handleNameUpdatedEvent };
