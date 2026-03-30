/**
 * RTC 信令路由表（纯数据模块）
 *
 * 维护 connId → { ws, botId, userId } 的 live 映射，
 * 供 rtc-signal-hub 和 bot-ws-hub 共享使用。
 * 无外部依赖、无定时器、无副作用。
 */

/** @type {Map<string, { ws: object, botId: string, userId: string }>} */
const routes = new Map();

/** @type {WeakMap<object, Set<string>>} */
const wsToConnIds = new WeakMap();

/**
 * 注册/更新 connId 路由。
 * connId 已被其他 WS 占用时返回 false；同一 WS 重复注册则更新。
 * @param {string} connId
 * @param {object} ws
 * @param {string} botId
 * @param {string} userId
 * @returns {boolean}
 */
export function register(connId, ws, botId, userId) {
	const existing = routes.get(connId);
	if (existing && existing.ws !== ws) {
		return false;
	}
	routes.set(connId, { ws, botId, userId });
	let set = wsToConnIds.get(ws);
	if (!set) {
		set = new Set();
		wsToConnIds.set(ws, set);
	}
	set.add(connId);
	return true;
}

/**
 * 移除单个 connId 路由。
 * @param {string} connId
 */
export function remove(connId) {
	const entry = routes.get(connId);
	if (!entry) return;
	routes.delete(connId);
	const set = wsToConnIds.get(entry.ws);
	if (set) {
		set.delete(connId);
	}
}

/**
 * 移除某 WS 下所有 connId 路由（WS 断开时调用）。
 * @param {object} ws
 */
export function removeByWs(ws) {
	const set = wsToConnIds.get(ws);
	if (!set) return;
	for (const connId of set) {
		routes.delete(connId);
	}
	wsToConnIds.delete(ws);
}

/**
 * 移除某 botId 下所有 connId 路由（bot 解绑时调用）。
 * @param {string} botId
 */
export function removeByBotId(botId) {
	for (const [connId, entry] of routes) {
		if (entry.botId === botId) {
			remove(connId);
		}
	}
}

/**
 * 查找 connId 对应的 WS 并投递 payload。
 * @param {string} connId
 * @param {object} payload
 * @returns {boolean} 是否投递成功
 */
export function routeToUi(connId, payload) {
	const entry = routes.get(connId);
	if (!entry) return false;
	if (entry.ws.readyState !== 1) return false; // 1 = OPEN
	try {
		entry.ws.send(JSON.stringify(payload));
		return true;
	} catch {
		return false;
	}
}

/**
 * 查找路由条目。
 * @param {string} connId
 * @returns {{ ws: object, botId: string, userId: string } | null}
 */
export function lookup(connId) {
	return routes.get(connId) ?? null;
}

// 测试辅助
export const __test = { routes, wsToConnIds };
