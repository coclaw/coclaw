/**
 * ChatStore 实例管理器
 * 为每个 chat/topic 维持独立的 Pinia store 实例，切换时不销毁数据
 */
import { useAgentRunsStore } from './agent-runs.store.js';
import { createChatStore } from './chat.store.js';

const MAX_TOPIC_INSTANCES = 10;

/** @type {Map<string, object>} */
const instances = new Map();
/** @type {string[]} topic storeKey 的最近使用序（末尾最新） */
const topicLru = [];

export const chatStoreManager = {
	/**
	 * 获取或创建 chat store 实例
	 * @param {string} storeKey - 'session:${clawId}:${agentId}' 或 'topic:${sessionId}'
	 * @param {object} [opts] - 首次创建时需要
	 * @param {string} [opts.clawId]
	 * @param {string} [opts.agentId]
	 * @returns {object} Pinia store 实例
	 */
	get(storeKey, opts) {
		let store = instances.get(storeKey);
		if (store) {
			if (storeKey.startsWith('topic:')) this.__touchTopic(storeKey);
			return store;
		}
		store = createChatStore(storeKey, opts);
		instances.set(storeKey, store);
		console.debug('[chatStoreMgr] created key=%s total=%d', storeKey, instances.size);
		if (storeKey.startsWith('topic:')) {
			topicLru.push(storeKey);
			this.__evictTopics();
		}
		return store;
	},

	/** 销毁指定实例 */
	dispose(storeKey) {
		const store = instances.get(storeKey);
		if (!store) return;
		console.debug('[chatStoreMgr] dispose key=%s remaining=%d', storeKey, instances.size - 1);
		store.dispose();
		store.$dispose();
		instances.delete(storeKey);
		const idx = topicLru.indexOf(storeKey);
		if (idx !== -1) topicLru.splice(idx, 1);
	},

	/**
	 * 登出清理：dispose 所有 chat/topic store 实例
	 * 遍历前 Array.from(keys) 快照，避免 dispose 内部 delete 导致 iterator 跳条目。
	 * per-item try/catch：单个 dispose 抛错不影响其余实例清理（防止 tickTimer / streamingTimer 泄漏）。
	 */
	disposeAll() {
		for (const key of Array.from(instances.keys())) {
			try { this.dispose(key); }
			catch (err) { console.debug('[chatStoreMgr] dispose key=%s failed: %s', key, err?.message); }
		}
	},

	/** @returns {number} 当前实例数 */
	get size() { return instances.size; },

	/** @returns {number} topic 实例数 */
	get topicCount() { return topicLru.length; },

	/** 遍历所有 store 实例 */
	stores() { return instances.values(); },

	/** 更新 topic LRU 顺序 */
	__touchTopic(storeKey) {
		const idx = topicLru.indexOf(storeKey);
		if (idx !== -1) topicLru.splice(idx, 1);
		topicLru.push(storeKey);
	},

	/** 淘汰超出上限且无活跃 run 的 topic 实例 */
	__evictTopics() {
		const runsStore = useAgentRunsStore();
		while (topicLru.length > MAX_TOPIC_INSTANCES) {
			let evicted = false;
			for (let i = 0; i < topicLru.length; i++) {
				const key = topicLru[i];
				const store = instances.get(key);
				if (store && runsStore.isRunning(store.runKey)) {
					console.debug('[chatStoreMgr] skip evict key=%s (active run)', key);
					continue;
				}
				console.debug('[chatStoreMgr] evict topic key=%s (lru=%d/%d)', key, topicLru.length, MAX_TOPIC_INSTANCES);
				// per-item try/catch：受害者 dispose 抛异常时不让它穿透到 get() 调用方，
				// 否则新 topic 已加入 instances/topicLru、被淘汰者也已加入 LRU，但调用方拿到异常
				try { this.dispose(key); }
				catch (err) {
					console.warn('[chatStoreMgr] evict dispose key=%s failed: %s', key, err?.message);
					// dispose 抛异常时，dispose() 内部还没把 key 从 instances / topicLru 移除，
					// 直接 break 会让 while-loop 反复挑同一个受害者 → 死循环。
					// 这里硬清掉受害者的 LRU 与 instances 索引，让淘汰能继续推进；
					// 同时兜底调一次 $dispose 释放 Pinia 订阅（store.dispose 抛之前 $dispose 还没跑）
					try { store?.$dispose(); } catch {}
					instances.delete(key);
					const lruIdx = topicLru.indexOf(key);
					if (lruIdx !== -1) topicLru.splice(lruIdx, 1);
				}
				evicted = true;
				break;
			}
			if (!evicted) {
				console.debug('[chatStoreMgr] eviction blocked: all topics have active runs (count=%d)', topicLru.length);
				break;
			}
		}
	},

	/** 测试用：重置所有实例（仅清理索引，不 dispose 避免已卸载组件的副作用） */
	__reset() {
		instances.clear();
		topicLru.length = 0;
	},
};
