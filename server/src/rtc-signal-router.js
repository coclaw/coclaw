/**
 * RTC 信令路由表（纯数据模块）
 *
 * 维护 connId → { ws, clawId, userId } 的 live 映射，
 * 供 rtc-signal-hub 和 claw-ws-hub 共享使用。
 * 无外部依赖、无定时器、无副作用。
 */

/** @type {Map<string, { ws: object, clawId: string, userId: string }>} */
const routes = new Map();

/** @type {WeakMap<object, Set<string>>} */
const wsToConnIds = new WeakMap();

/**
 * 注册/更新 connId 路由。
 *
 * 冲突处理（新 ws 携带已有 connId 到达）：
 * - 若 userId 不匹配 → 拒绝（唯一安全边界：connId 是 UUID，同 userId 的 connId 冲突
 *   必然是"同一 UI 实例迁移到新 WS"的信号）
 * - 否则把旧 WS 上的**全部** connId 原子迁到新 WS，然后 terminate 旧 WS。此时
 *   migrated=true。触发条目的 clawId 保持 existing 原值（UI 端 connId 绑 claw，
 *   正常不会错；若异常错位，以 server 已记录的历史事实为准）。
 *
 * @param {string} connId
 * @param {object} ws
 * @param {string} clawId
 * @param {string} userId
 * @returns {{ ok: boolean, migrated: boolean }}
 */
export function register(connId, ws, clawId, userId) {
	const existing = routes.get(connId);
	if (existing && existing.ws !== ws) {
		if (existing.userId !== userId) {
			return { ok: false, migrated: false };
		}
		// WS 级整体迁移：搬走旧 WS 上的全部 connId
		const oldWs = existing.ws;
		const oldSet = wsToConnIds.get(oldWs);
		let newSet = wsToConnIds.get(ws);
		if (!newSet) {
			newSet = new Set();
			wsToConnIds.set(ws, newSet);
		}
		if (oldSet) {
			for (const cid of oldSet) {
				const e = routes.get(cid);
				if (!e || e.ws !== oldWs) continue;
				routes.set(cid, { ws, clawId: e.clawId, userId: e.userId });
				newSet.add(cid);
			}
			wsToConnIds.delete(oldWs);
		}
		// 防御：若 oldSet 与 routes 不同步（数据损坏场景），至少保证触发 connId 被迁走；
		// 同时作为 fast path：oldSet 正常时此处是一次幂等覆盖
		routes.set(connId, { ws, clawId: existing.clawId, userId });
		newSet.add(connId);
		// 主动收尸：半开场景下 close() 可能永久挂起，terminate 更稳（参考 claw-ws-hub.js 的 stale-socket 淘汰）。
		// terminate 异常刻意静默——router 保持纯数据模块、不引日志；迁移状态已落地、异常不影响正确性。
		try {
			if (typeof oldWs.terminate === 'function') oldWs.terminate();
			else if (typeof oldWs.close === 'function') oldWs.close(4000, 'migrated');
		} catch { /* noop */ }
		return { ok: true, migrated: true };
	}
	routes.set(connId, { ws, clawId, userId });
	let set = wsToConnIds.get(ws);
	if (!set) {
		set = new Set();
		wsToConnIds.set(ws, set);
	}
	set.add(connId);
	return { ok: true, migrated: false };
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
 * 防御：仅删除 routes 中仍指向该 ws 的条目——避免 register 迁移后
 * 旧 WS 的延迟 close 事件误删新 WS 的路由。
 * @param {object} ws
 */
export function removeByWs(ws) {
	const set = wsToConnIds.get(ws);
	if (!set) return;
	for (const connId of set) {
		const entry = routes.get(connId);
		if (entry && entry.ws === ws) routes.delete(connId);
	}
	wsToConnIds.delete(ws);
}

/**
 * 移除某 clawId 下所有 connId 路由（claw 解绑时调用）。
 * @param {string} clawId
 */
export function removeByClawId(clawId) {
	for (const [connId, entry] of routes) {
		if (entry.clawId === clawId) {
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
 * @returns {{ ws: object, clawId: string, userId: string } | null}
 */
export function lookup(connId) {
	return routes.get(connId) ?? null;
}

// 测试辅助
export const __test = { routes, wsToConnIds };
