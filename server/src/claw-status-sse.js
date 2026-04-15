import { findClawById, listClawsByUserId } from './repos/claw.repo.js';
import { clawStatusEmitter, listOnlineClawIds } from './claw-ws-hub.js';

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
 * 向单个 SSE 客户端推送全量 claw 快照
 * @param {string|bigint} userId
 * @param {import('express').Response} res
 * @param {{ listClawsByUserIdImpl?: Function, listOnlineClawIdsImpl?: Function }} [deps]
 */
export async function sendSnapshot(userId, res, deps = {}) {
	const {
		listClawsByUserIdImpl = listClawsByUserId,
		listOnlineClawIdsImpl = listOnlineClawIds,
	} = deps;
	const claws = await listClawsByUserIdImpl(userId);
	const onlineIds = listOnlineClawIdsImpl();
	const items = claws.map((c) => {
		const clawId = c.id.toString();
		return {
			id: clawId,
			name: c.name,
			online: onlineIds.has(clawId),
			lastSeenAt: c.lastSeenAt,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt,
		};
	});
	// 先发 claw.snapshot（新版 UI），再发 bot.snapshot（旧版 UI）
	const clawMsg = `data: ${JSON.stringify({ event: 'claw.snapshot', items })}\n\n`;
	const botMsg = `data: ${JSON.stringify({ event: 'bot.snapshot', items })}\n\n`;
	try {
		res.write(clawMsg);
		res.write(botMsg);
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
 * 处理 claw status 变更事件
 * @param {object} param0
 * @param {string} param0.clawId
 * @param {boolean} param0.online
 * @param {{ findClawByIdFn?: Function }} [deps]
 */
async function handleStatusEvent({ clawId, online }, deps = {}) {
	const { findClawByIdFn = findClawById } = deps;
	if (!hasSseClients()) {
		return;
	}
	try {
		const claw = await findClawByIdFn(BigInt(clawId));
		if (!claw) {
			console.debug('[coclaw/sse] status event: claw not found clawId=%s (may be deleted)', clawId);
			return;
		}
		const userId = String(claw.userId);
		// 先发 claw.*（新版 UI），再发 bot.*（旧版 UI）
		sendToUser(userId, {
			event: 'claw.status',
			clawId: String(clawId),
			online,
		});
		sendToUser(userId, {
			event: 'bot.status',
			botId: String(clawId),
			clawId: String(clawId),
			online,
		});
	}
	catch (err) {
		console.warn('[coclaw/sse] status event push failed clawId=%s: %s', clawId, err?.message);
	}
}

/**
 * 处理 claw 信息变更事件（plugin 上报，patch 语义）。
 * 用户侧 SSE 仅关心 name：本次 patch 不含 name 字段时直接返回（避免无变化的事件刷新）；
 * 其余字段（hostName/pluginVersion/agentModels）透传给 admin SSE。
 * @param {object} evt
 * @param {string} evt.clawId
 * @param {string} [evt.name] - 本次 patch 不含 name 时为 undefined
 * @param {{ findClawByIdFn?: Function }} [deps]
 */
async function handleInfoUpdatedEvent(evt, deps = {}) {
	const { findClawByIdFn = findClawById } = deps;
	const { clawId, name } = evt;
	// name 未在 patch 中出现 → user-facing SSE 无需下发（admin SSE 走独立监听器）
	if (!Object.hasOwn(evt, 'name')) {
		return;
	}
	if (!hasSseClients()) {
		return;
	}
	try {
		const claw = await findClawByIdFn(BigInt(clawId));
		if (!claw) {
			console.debug('[coclaw/sse] infoUpdated event: claw not found clawId=%s (may be deleted)', clawId);
			return;
		}
		const userId = String(claw.userId);
		sendToUser(userId, {
			event: 'claw.nameUpdated',
			clawId: String(clawId),
			name,
		});
		sendToUser(userId, {
			event: 'bot.nameUpdated',
			botId: String(clawId),
			clawId: String(clawId),
			name,
		});
	}
	catch (err) {
		console.warn('[coclaw/sse] infoUpdated event push failed clawId=%s: %s', clawId, err?.message);
	}
}

clawStatusEmitter.on('status', (data) => handleStatusEvent(data));
clawStatusEmitter.on('infoUpdated', (data) => handleInfoUpdatedEvent(data));

// 测试辅助
export const __test = { handleStatusEvent, handleInfoUpdatedEvent };
