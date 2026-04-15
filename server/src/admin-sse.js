import { clawStatusEmitter, listOnlineClawIds } from './claw-ws-hub.js';

// admin 全局 SSE 客户端集合（非用户分桶：admin 能看见全量 claw）
const adminSseClients = new Set();

/**
 * 注册 admin SSE 客户端：先推 snapshot 再加入广播集合。
 * @param {import('express').Response} res
 * @param {{ listOnlineClawIdsImpl?: Function }} [deps]
 */
export function registerAdminSseClient(res, deps = {}) {
	const { listOnlineClawIdsImpl = listOnlineClawIds } = deps;
	const snapshot = {
		event: 'snapshot',
		onlineClawIds: [...listOnlineClawIdsImpl()].map(String),
	};
	try {
		res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
	} catch (err) {
		console.warn('[coclaw/admin-sse] snapshot write failed: %s', err?.message);
	}
	adminSseClients.add(res);
	console.info('[coclaw/admin-sse] connected clients=%d', adminSseClients.size);

	res.on('close', () => {
		adminSseClients.delete(res);
		console.info('[coclaw/admin-sse] disconnected clients=%d', adminSseClients.size);
	});
}

/** 当前是否有 admin SSE 连接 */
export function hasAdminSseClients() {
	return adminSseClients.size > 0;
}

function broadcast(data) {
	if (adminSseClients.size === 0) {
		return;
	}
	const msg = `data: ${JSON.stringify(data)}\n\n`;
	for (const res of adminSseClients) {
		try {
			res.write(msg);
		}
		catch (err) {
			console.debug('[coclaw/admin-sse] write failed: %s', err?.message);
		}
	}
}

function handleStatusEvent({ clawId, online }) {
	broadcast({ event: 'claw.statusChanged', clawId: String(clawId), online });
}

function handleInfoUpdatedEvent({ clawId, name, hostName, pluginVersion, agentModels }) {
	broadcast({
		event: 'claw.infoUpdated',
		clawId: String(clawId),
		name,
		hostName,
		pluginVersion,
		agentModels,
	});
}

clawStatusEmitter.on('status', handleStatusEvent);
clawStatusEmitter.on('infoUpdated', handleInfoUpdatedEvent);

// 测试辅助
export const __test = { handleStatusEvent, handleInfoUpdatedEvent, broadcast, adminSseClients };
