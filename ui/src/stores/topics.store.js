/**
 * Topics Store — 管理用户主动创建的独立话题（Topic）
 * Topic 是完全由 CoClaw 管理的独立对话，不在 OpenClaw 的 sessions.json 中
 */
import { defineStore } from 'pinia';

import { useClawsStore } from './claws.store.js';
import { getReadyConn } from './get-ready-conn.js';
import { useClawConnections } from '../services/claw-connection-manager.js';

let _loadingPromise = null;
/** per-claw 加载合流（clawId → Promise），与全量 _loadingPromise 互不干扰 */
const _perClawLoading = new Map();

/** 正在生成标题的 topicId 集合，防止并发请求 */
const _generatingTopics = new Set();

/** 重置模块级状态（logout / 测试） */
export function __resetTopicsInternals() {
	_loadingPromise = null;
	_perClawLoading.clear();
	_generatingTopics.clear();
}

export const useTopicsStore = defineStore('topics', {
	state: () => ({
		/** @type {Record<string, { topicId: string, agentId: string, title: string | null, createdAt: number, clawId: string }>} */
		byId: {},
		loading: false,
	}),
	getters: {
		/** 列表视图（供列表渲染和遍历用） */
		items: (state) => Object.values(state.byId),
		/**
		 * 按 topicId 查找 topic
		 * @returns {(topicId: string) => { topicId: string, agentId: string, title: string | null, createdAt: number, clawId: string } | null}
		 */
		findTopic: (state) => (topicId) => {
			return state.byId[topicId] ?? null;
		},
	},
	actions: {
		async loadAllTopics() {
			if (_loadingPromise) {
				console.debug('[topics] loadAll: coalesced with pending request');
				return _loadingPromise;
			}
			const clawsStore = useClawsStore();
			const claws = clawsStore.items ?? [];
			if (!claws.length) {
				this.byId = {};
				return;
			}
			const connectedClaws = claws.filter((b) => getReadyConn(b.id));
			if (!connectedClaws.length) {
				console.debug('[topics] loadAll: no connected claws, skipping reload');
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

		async __doLoadAll(connectedClaws) {
			const clawsStore = useClawsStore();
			const queriedClawIds = new Set(connectedClaws.map((b) => String(b.id)));
			const tasks = [];
			for (const claw of connectedClaws) {
				const conn = getReadyConn(claw.id);
				if (!conn) continue;
				// 当前版本只支持 main agent 的 topic（受限于 OpenClaw agent 路由机制）
				tasks.push(
					conn.request('coclaw.topics.list', { agentId: 'main' }, { timeout: 60_000 })
						.then((res) => ({
							topics: Array.isArray(res?.topics) ? res.topics : [],
							clawId: String(claw.id),
						}))
				);
			}
			const results = await Promise.allSettled(tasks);
			// fetch 失败的 claw：从 queriedClawIds 移除，保留其旧 topics
			for (let i = 0; i < results.length; i++) {
				if (results[i].status !== 'fulfilled') {
					const failedId = String(connectedClaws[i].id);
					queriedClawIds.delete(failedId);
					console.warn('[topics] load failed for one agent:', results[i].reason);
				}
			}
			// 增量合并：保留未查询 claw 的已有 topics，替换已查询 claw 的
			const newById = {};
			for (const [tid, topic] of Object.entries(this.byId)) {
				const bid = String(topic.clawId);
				// 跳过本次查询范围内的（用新结果替换）和已不存在的 claw
				if (queriedClawIds.has(bid) || !clawsStore.byId[bid]) continue;
				newById[tid] = topic;
			}
			for (const r of results) {
				if (r.status !== 'fulfilled') continue;
				for (const topic of r.value.topics) {
					newById[topic.topicId] = {
						topicId: topic.topicId,
						agentId: topic.agentId,
						title: topic.title ?? null,
						createdAt: topic.createdAt ?? 0,
						clawId: r.value.clawId,
					};
				}
			}
			this.byId = newById;
			console.debug('[topics] loadAll: merged %d topic(s) (queried %d claw(s))', Object.keys(newById).length, queriedClawIds.size);
		},

		/**
		 * 按 claw 加载 topics。专为 per-claw 触发场景（DC 重连恢复 / 首次 init），
		 * 避免 loadAllTopics() 在多 claw 错峰恢复时的 N² RPC 放大。
		 * - 同 claw 并发调用合流到同一 promise
		 * - 仅替换该 claw 的 topics，其他 claw 的旧数据保留
		 * - fetch 失败保留旧 topics（不清空）
		 * @param {string} clawId
		 */
		async loadTopicsForClaw(clawId) {
			const id = String(clawId);
			const inflight = _perClawLoading.get(id);
			if (inflight) {
				console.debug('[topics] loadForClaw: coalesced clawId=%s', id);
				return inflight;
			}
			const conn = getReadyConn(id);
			if (!conn) {
				console.debug('[topics] loadForClaw: skipped (no connected) clawId=%s', id);
				return;
			}
			const promise = this.__doLoadForClaw(id, conn);
			_perClawLoading.set(id, promise);
			// 仅当 Map 当前条目仍是本 promise 时才清，避免 removeByClaw 后重入新建的
			// 飞行 promise 被老 promise 的 finally 误删
			promise.finally(() => {
				if (_perClawLoading.get(id) === promise) _perClawLoading.delete(id);
			});
			return promise;
		},
		async __doLoadForClaw(id, conn) {
			let topics;
			try {
				const res = await conn.request('coclaw.topics.list', { agentId: 'main' }, { timeout: 60_000 });
				topics = Array.isArray(res?.topics) ? res.topics : [];
			}
			catch (err) {
				console.warn('[topics] loadForClaw failed clawId=%s:', id, err);
				return; // 保留旧 topics
			}
			const clawsStore = useClawsStore();
			// fetch 期间 claw 可能被 SSE claw.unbound 移除（cleanupClawResources 已同步清空）
			// → 此时不能把刚拉到的 topics 写回，否则成为"幽灵数据"
			if (!clawsStore.byId[id]) {
				console.debug('[topics] loadForClaw: claw removed during fetch clawId=%s', id);
				return;
			}
			const newById = {};
			for (const [tid, topic] of Object.entries(this.byId)) {
				const bid = String(topic.clawId);
				if (bid === id) continue; // 当前 claw 的旧 topic 用新结果替换
				if (!clawsStore.byId[bid]) continue; // 顺手清理已不存在的 claw
				newById[tid] = topic;
			}
			for (const topic of topics) {
				newById[topic.topicId] = {
					topicId: topic.topicId,
					agentId: topic.agentId,
					title: topic.title ?? null,
					createdAt: topic.createdAt ?? 0,
					clawId: id,
				};
			}
			this.byId = newById;
			console.debug('[topics] loadForClaw: merged %d topic(s) clawId=%s', topics.length, id);
		},

		/**
		 * 创建新 topic
		 * @param {string} clawId
		 * @param {string} agentId
		 * @returns {Promise<string>} topicId
		 */
		async createTopic(clawId, agentId) {
			const conn = useClawConnections().get(String(clawId));
			if (!conn) throw new Error('Claw not connected');
			const result = await conn.request('coclaw.topics.create', { agentId }, { timeout: 60_000 });
			const topicId = result?.topicId;
			if (!topicId) throw new Error('Failed to create topic');
			this.byId[topicId] = { topicId, agentId, title: null, createdAt: Date.now(), clawId: String(clawId) };
			return topicId;
		},

		/**
		 * 删除 topic
		 * @param {string} clawId
		 * @param {string} topicId
		 */
		async deleteTopic(clawId, topicId) {
			const conn = getReadyConn(clawId);
			if (!conn) throw new Error('Claw not connected');
			const result = await conn.request('coclaw.topics.delete', { topicId }, { timeout: 60_000 });
			if (result?.ok === false) throw new Error('Topic not found');
			delete this.byId[topicId];
		},

		/**
		 * 更新 topic 元信息（当前仅支持 title）
		 * @param {string} clawId
		 * @param {string} topicId
		 * @param {{ title?: string }} changes
		 */
		async updateTopic(clawId, topicId, changes) {
			const conn = getReadyConn(clawId);
			if (!conn) throw new Error('Claw not connected');
			const result = await conn.request('coclaw.topics.update', { topicId, changes }, { timeout: 60_000 });
			const updated = result?.topic;
			if (!updated) throw new Error('Update failed');
			if (this.byId[topicId]) {
				this.byId[topicId] = { ...this.byId[topicId], ...updated };
			}
		},

		/** 移除指定 claw 的所有 topics */
		removeByClaw(clawId) {
			const id = String(clawId);
			for (const [tid, topic] of Object.entries(this.byId)) {
				if (String(topic.clawId) === id) delete this.byId[tid];
			}
			// 同步清飞行中 dedup：claw 同 id 重绑时新 loadForClaw 不应 coalesce 到老 promise
			_perClawLoading.delete(id);
		},

		/**
		 * 异步生成 topic 标题（fire-and-forget，不阻塞调用方）
		 * @param {string} clawId
		 * @param {string} topicId
		 */
		generateTitle(clawId, topicId) {
			if (_generatingTopics.has(topicId)) return;
			const conn = getReadyConn(clawId);
			if (!conn) return;
			_generatingTopics.add(topicId);
			conn.request('coclaw.topics.generateTitle', { topicId }, { timeout: 600_000 })
				.then((res) => {
					const title = res?.title;
					if (!title) return;
					if (this.byId[topicId]) {
						this.byId[topicId] = { ...this.byId[topicId], title };
					}
				})
				.catch((err) => {
					console.warn('[topics] generateTitle failed:', err);
				})
				.finally(() => {
					_generatingTopics.delete(topicId);
				});
		},
	},
});
