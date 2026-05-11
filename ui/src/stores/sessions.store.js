import { defineStore } from 'pinia';

import { useAgentsStore } from './agents.store.js';
import { useClawsStore } from './claws.store.js';
import { getReadyConn } from './get-ready-conn.js';

// 模块级变量，避免被 Pinia reactive 代理包裹
let _loadingPromise = null;
/** per-claw 加载合流（clawId → Promise），与全量 _loadingPromise 互不干扰 */
const _perClawLoading = new Map();
/**
 * per-claw 原始 sessions 元数据缓存（clawId → GatewaySessionRow[]）
 * dashboard 经 getRawSessionsForClaw 读取，与 SessionItem 同生命周期：
 * fetch 通过 claw 合法性检查后才写入；fetch 失败保留旧值，与业务列表风格一致
 */
const _rawByClaw = new Map();

/** 重置模块级状态（logout / 测试） */
export function __resetSessionsInternals() {
	_loadingPromise = null;
	_perClawLoading.clear();
	_rawByClaw.clear();
}

/**
 * @typedef {object} SessionItem
 * @property {string} sessionId - 该 chat 当前 live session 的 sessionId（agent:<id>:main）；bump-only 占位为 ''
 * @property {string} sessionKey - 始终是 live key 'agent:<agentId>:main'
 * @property {string} clawId
 * @property {string} agentId
 * @property {number|null} updatedAt - 来自 sessions.list 的最近活动时间（server 真相，毫秒）
 *   取该 agent 名下所有 sessions（key 以 'agent:<agentId>:' 开头）的 max(updatedAt)
 * @property {number|null} bumpedAt - 本地乐观活动时间（毫秒）
 *   sendMessage / sendSlashCommand 入口写 Date.now()；sessions.list 不碰
 */

export const useSessionsStore = defineStore('sessions', {
	state: () => ({
		/** @type {SessionItem[]} */
		items: [],
		loading: false,
	}),
	getters: {
		/**
		 * 取某个 chat 的"最近活动时间"，供 MainList 排序使用。
		 * = max(updatedAt, bumpedAt)；都缺失返回 0（落底部）。
		 * @returns {(clawId: string, agentId: string) => number}
		 */
		getActivity: (state) => (clawId, agentId) => {
			const id = String(clawId);
			for (const s of state.items) {
				if (s.clawId === id && s.agentId === agentId) {
					return Math.max(s.updatedAt ?? 0, s.bumpedAt ?? 0);
				}
			}
			return 0;
		},
	},
	actions: {
		setSessions(items) {
			this.items = Array.isArray(items) ? items : [];
		},
		removeSessionsByClawId(clawId) {
			const id = String(clawId ?? '');
			this.items = this.items.filter((s) => String(s.clawId) !== id);
			// 同步清飞行中 dedup：claw 同 id 重绑时新 loadForClaw 不应 coalesce 到老 promise
			_perClawLoading.delete(id);
			// 同步清 raw 缓存：与 SessionItem 同生命周期，避免老 raw 残留到下次同 id 重绑
			_rawByClaw.delete(id);
		},
		/**
		 * 本地乐观活动标记。sendMessage / sendSlashCommand 入口调用，让 MainList
		 * 立刻把该 agent 浮顶（不等下一次 sessions.list 拉到 server updatedAt）。
		 *
		 * 不存在对应 item 时 upsert 一条占位（典型场景：全新 agent，第一条消息发出时
		 * sessions.list 上还没记录）；下次 sessions.list 回来会原地补上 sessionId/updatedAt，
		 * bumpedAt 不被覆盖。
		 *
		 * @param {string} clawId
		 * @param {string} agentId
		 * @param {number} [ts] - 默认 Date.now()
		 */
		bumpActivity(clawId, agentId, ts = Date.now()) {
			if (!clawId || !agentId) return;
			const id = String(clawId);
			const sessionKey = `agent:${agentId}:main`;
			const idx = this.items.findIndex((s) => s.clawId === id && s.agentId === agentId);
			if (idx >= 0) {
				const next = [...this.items];
				next[idx] = { ...next[idx], bumpedAt: ts };
				this.items = next;
			} else {
				this.items = [
					...this.items,
					{
						sessionId: '',
						sessionKey,
						clawId: id,
						agentId,
						updatedAt: null,
						bumpedAt: ts,
					},
				];
			}
		},
		async loadAllSessions() {
			// 已有加载中的请求，合流等待
			if (_loadingPromise) {
				console.debug('[sessions] loadAll: coalesced with pending request');
				return _loadingPromise;
			}
			const clawsStore = useClawsStore();
			const claws = clawsStore.items ?? [];
			if (!claws.length) {
				console.debug('[sessions] loadAll: skipped (no claws)');
				this.items = [];
				return;
			}
			const connectedClaws = claws.filter((b) => getReadyConn(b.id));
			if (!connectedClaws.length) {
				console.debug('[sessions] loadAll: skipped (no connected claws, total=%d)', claws.length);
				return;
			}
			this.loading = true;
			_loadingPromise = this.__doLoadAll(connectedClaws);
			try {
				await _loadingPromise;
			}
			finally {
				_loadingPromise = null;
				this.loading = false;
			}
		},
		// 合流到 per-claw 入口：与 loadSessionsForClaw 共享 _perClawLoading 飞行缓存，
		// 消除"全量拉 vs 按 claw 拉"两套缓存互不感知导致的重复 sessions.list RPC
		async __doLoadAll(connectedClaws) {
			const results = await Promise.allSettled(
				connectedClaws.map((claw) => this.loadSessionsForClaw(claw.id)),
			);
			// fetch 失败由 __doLoadForClaw 内部 catch + warn；这里捕获更外层的异常
			// （如 mergeFetchResults 抛错），避免被 allSettled 静默吞掉
			for (let i = 0; i < results.length; i++) {
				if (results[i].status === 'rejected') {
					console.warn('[sessions] loadAll: per-claw load rejected clawId=%s:', connectedClaws[i].id, results[i].reason);
				}
			}
		},
		/**
		 * 按 claw 加载 sessions。专为 per-claw 触发场景（DC 重连恢复 / 首次 init），
		 * 避免 loadAllSessions() 在多 claw 错峰恢复时的 N² RPC 放大。
		 * - 同 claw 并发调用合流到同一 promise（force/非 force 语义见下）
		 * - 仅替换该 claw 的 sessions，其他 claw 的旧数据保留
		 * - fetch 失败保留旧 sessions（不清空）
		 *
		 * force 合流策略（与 dashboard.store loadDashboard 对称，保证 force 语义不被吞）：
		 * - force=true 看到非 force 飞行：等其完成后启动新一轮（确保拿到新拉取的 raw）
		 * - force=true 看到 force 飞行：合流（同样要新数据，复用即可）
		 * - 非 force 看到任何飞行：合流（任何正在跑的拉取都足以满足 freshness）
		 * @param {string} clawId
		 * @param {{ force?: boolean }} [opts] - force=true 时 getRawSessionsForClaw / 重连恢复链路要求新鲜数据
		 */
		async loadSessionsForClaw(clawId, { force = false } = {}) {
			const id = String(clawId);
			const inflight = _perClawLoading.get(id);
			if (inflight) {
				if (force && !inflight.force) {
					// force 调用不能合流到非 force 飞行——拿到的可能是 force 前已在跑的旧拉取
					console.debug('[sessions] loadForClaw: force chained after non-force inflight clawId=%s', id);
					return inflight.p
						.catch(() => {})
						.then(() => this.loadSessionsForClaw(id, { force: true }));
				}
				console.debug('[sessions] loadForClaw: coalesced clawId=%s', id);
				return inflight.p;
			}
			if (!getReadyConn(id)) {
				console.debug('[sessions] loadForClaw: skipped (no connected) clawId=%s', id);
				return;
			}
			const promise = this.__doLoadForClaw(id);
			_perClawLoading.set(id, { p: promise, force });
			// 仅当 Map 当前条目仍是本 promise 时才清，避免老 promise 的 finally 把
			// removeSessionsByClawId + 重入新建的飞行 promise 一起删掉
			promise.finally(() => {
				if (_perClawLoading.get(id)?.p === promise) _perClawLoading.delete(id);
			});
			return promise;
		},
		async __doLoadForClaw(id) {
			let raw, items;
			try {
				({ raw, items } = await this.__fetchSessionsForClaw(id));
			}
			catch (err) {
				// 防御：__fetchSessionsForClaw 当前不会抛，万一未来改动抛了也保留旧数据
				console.warn('[sessions] loadForClaw failed clawId=%s:', id, err);
				return;
			}
			const clawsStore = useClawsStore();
			// fetch 期间 claw 可能被 SSE claw.unbound 移除（cleanupClawResources 已同步清空）
			// → 此时不能把刚拉到的 sessions 写回，否则成为"幽灵数据"；raw 也同样不能写
			if (!clawsStore.byId[id]) {
				console.debug('[sessions] loadForClaw: claw removed during fetch clawId=%s', id);
				return;
			}
			// 通过合法性检查后，raw 与 SessionItem 同步写入；两者同生命周期，避免 dashboard 拿到的 raw 与业务列表脱钩
			_rawByClaw.set(id, raw);
			this.items = mergeFetchResults({
				prevItems: this.items,
				results: [{ status: 'fulfilled', value: items }],
				queriedClawIds: new Set([id]),
				clawsById: clawsStore.byId,
			});
			console.debug('[sessions] loadForClaw: merged %d session(s) clawId=%s', items.length, id);
		},
		/**
		 * 取指定 claw 的原始 sessions 元数据数组（dashboard 用于计算 totalTokens / activeSessions / lastActivity）
		 * - 命中 raw 缓存 + 无飞行 + 非 force → 直接复用，不发 RPC
		 * - 其他情况委托给 loadSessionsForClaw（含 force 飞行识别，见 loadSessionsForClaw 注释）
		 * - 失败保留旧值（与 SessionItem 同生命周期）：fetch 抛错或 claw 移除时 raw 不更新
		 * @param {string} clawId
		 * @param {{ force?: boolean }} [opts]
		 * @returns {Promise<object[]>}
		 */
		async getRawSessionsForClaw(clawId, { force = false } = {}) {
			const id = String(clawId);
			if (!force && _rawByClaw.has(id) && !_perClawLoading.has(id)) {
				return _rawByClaw.get(id);
			}
			await this.loadSessionsForClaw(id, { force });
			return _rawByClaw.get(id) ?? [];
		},
		/**
		 * 拉取指定 claw 的 sessions：一次 sessions.list RPC 拿全部，按 agent 切片。
		 * 同时返回原始元数据（raw）供 dashboard 计算统计；折叠后的 items 作为 SessionItem 用于业务列表。
		 * @param {string} clawId
		 * @returns {Promise<{ raw: object[], items: SessionItem[] }>}
		 */
		async __fetchSessionsForClaw(clawId) {
			const conn = getReadyConn(clawId);
			if (!conn) return { raw: [], items: [] };

			const agentsStore = useAgentsStore();
			const agents = agentsStore.getAgentsByClaw(clawId);
			// 若 agentsStore 未加载完成，fallback 到 ['main']
			const agentIds = agents.length ? agents.map((a) => a.id) : ['main'];

			// 不在此处吞 RPC 错误：让外层 Promise.allSettled 看到 rejected 状态，
			// 合并环节按"未查询"路径保留旧条目（与 chat.history 时代的语义一致）
			const result = await conn.request('sessions.list', {}, { timeout: 60_000 });
			const sessionList = Array.isArray(result?.sessions) ? result.sessions : [];

			const id = String(clawId);
			const items = [];
			for (const agentId of agentIds) {
				const prefix = `agent:${agentId}:`;
				const liveKey = `agent:${agentId}:main`;
				let sessionId = '';
				let maxUpdatedAt = 0;
				for (const s of sessionList) {
					if (typeof s?.key !== 'string' || !s.key.startsWith(prefix)) continue;
					if (s.key === liveKey && typeof s.sessionId === 'string' && s.sessionId) {
						sessionId = s.sessionId;
					}
					if (typeof s.updatedAt === 'number' && s.updatedAt > maxUpdatedAt) {
						maxUpdatedAt = s.updatedAt;
					}
				}
				// 该 agent 完全无 session 痕迹 → 不创建 item（让 MainList fallback 到 0 落底部）
				if (!sessionId && !maxUpdatedAt) continue;
				items.push({
					sessionId,
					sessionKey: liveKey,
					clawId: id,
					agentId,
					updatedAt: maxUpdatedAt || null,
					bumpedAt: null,
				});
			}
			return { raw: sessionList, items };
		},
	},
});

/**
 * 合并 sessions.list 拉回结果：保留未查询 claw 旧条目；查询过的 claw 用新结果替换，
 * 但每条 item 保留 oldByChatKey 中的 bumpedAt（sessions.list 看不到本地乐观标记）。
 *
 * "已查询 claw 中 server 没返回但本地有 bumpedAt 的 chat" 也保留——典型场景：
 * 用户刚发完消息走 bumpActivity，sessions.list 同时在飞，server 还没把消息写盘到
 * sessions store，新结果里没这条；不保留 bumpedAt 会让该 agent 在列表里掉下去。
 *
 * @param {object} args
 * @param {SessionItem[]} args.prevItems
 * @param {PromiseSettledResult<SessionItem[]>[]} args.results
 * @param {Set<string>} args.queriedClawIds
 * @param {Record<string, object>} args.clawsById - clawsStore.byId（用于清理已不存在的 claw 旧条目）
 * @returns {SessionItem[]}
 */
function mergeFetchResults({ prevItems, results, queriedClawIds, clawsById }) {
	const oldByChatKey = new Map();
	for (const s of prevItems) {
		oldByChatKey.set(`${s.clawId}:${s.agentId}`, s);
	}
	const newChatKeys = new Set();
	const merged = [];

	// 保留未查询 claw 的旧条目（顺手清理 clawsStore 中已不存在的 claw）
	for (const s of prevItems) {
		const bid = String(s.clawId);
		if (queriedClawIds.has(bid) || !clawsById[bid]) continue;
		merged.push(s);
	}

	// 新条目：合入查询结果，复用旧 bumpedAt
	for (const r of results) {
		if (r.status !== 'fulfilled') continue;
		for (const item of r.value) {
			const chatKey = `${item.clawId}:${item.agentId}`;
			newChatKeys.add(chatKey);
			const old = oldByChatKey.get(chatKey);
			merged.push(old?.bumpedAt
				? { ...item, bumpedAt: old.bumpedAt }
				: item);
		}
	}

	// 已查询 claw 中"server 没返回但本地有 bumpedAt"的 chat：保留为 bump-only 占位
	// （server 真相已清零，但乐观浮顶不掉）
	for (const s of prevItems) {
		const bid = String(s.clawId);
		if (!queriedClawIds.has(bid)) continue;
		const chatKey = `${s.clawId}:${s.agentId}`;
		if (newChatKeys.has(chatKey)) continue;
		if (!s.bumpedAt) continue;
		merged.push({ ...s, sessionId: '', updatedAt: null });
	}

	return merged;
}
