/**
 * Topics Store — 管理用户主动创建的独立话题（Topic）
 * Topic 是完全由 CoClaw 管理的独立对话，不在 OpenClaw 的 sessions.json 中
 */
import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { useBotsStore } from './bots.store.js';

let _loadingPromise = null;

export const useTopicsStore = defineStore('topics', {
	state: () => ({
		/** @type {{ topicId: string, agentId: string, title: string | null, createdAt: number, botId: string }[]} */
		items: [],
		loading: false,
	}),
	getters: {
		/**
		 * 按 topicId 查找 topic
		 * @returns {(topicId: string) => { topicId: string, agentId: string, title: string | null, createdAt: number, botId: string } | null}
		 */
		findTopic: (state) => (topicId) => {
			return state.items.find((t) => t.topicId === topicId) ?? null;
		},
	},
	actions: {
		async loadAllTopics() {
			if (_loadingPromise) {
				console.debug('[topics] loadAll: coalesced with pending request');
				return _loadingPromise;
			}
			const botsStore = useBotsStore();
			const bots = botsStore.items ?? [];
			if (!bots.length) {
				this.items = [];
				return;
			}
			const manager = useBotConnections();
			const connectedBots = bots.filter((b) => {
				const conn = manager.get(b.id);
				return conn && conn.state === 'connected';
			});
			if (!connectedBots.length) {
				console.debug('[topics] loadAll: no connected bots, clearing items');
				this.items = [];
				return;
			}
			this.loading = true;
			_loadingPromise = this.__doLoadAll(connectedBots);
			try {
				await _loadingPromise;
			}
			finally {
				_loadingPromise = null;
				this.loading = false;
			}
		},

		async __doLoadAll(connectedBots) {
			const manager = useBotConnections();
			const tasks = [];
			for (const bot of connectedBots) {
				const conn = manager.get(String(bot.id));
				if (!conn || conn.state !== 'connected') continue;
				// 当前版本只支持 main agent 的 topic（受限于 OpenClaw agent 路由机制）
				tasks.push(
					conn.request('coclaw.topics.list', { agentId: 'main' })
						.then((res) => ({
							topics: Array.isArray(res?.topics) ? res.topics : [],
							botId: String(bot.id),
						}))
				);
			}
			const results = await Promise.allSettled(tasks);
			const merged = [];
			for (const r of results) {
				if (r.status !== 'fulfilled') {
					console.warn('[topics] load failed for one agent:', r.reason);
					continue;
				}
				for (const topic of r.value.topics) {
					merged.push({
						topicId: topic.topicId,
						agentId: topic.agentId,
						title: topic.title ?? null,
						createdAt: topic.createdAt ?? 0,
						botId: r.value.botId,
					});
				}
			}
			this.items = merged;
			console.debug('[topics] loadAll: merged %d topic(s)', merged.length);
		},

		/**
		 * 创建新 topic
		 * @param {string} botId
		 * @param {string} agentId
		 * @returns {Promise<string>} topicId
		 */
		async createTopic(botId, agentId) {
			const conn = useBotConnections().get(String(botId));
			if (!conn || conn.state !== 'connected') throw new Error('Bot not connected');
			const result = await conn.request('coclaw.topics.create', { agentId });
			const topicId = result?.topicId;
			if (!topicId) throw new Error('Failed to create topic');
			// 插入本地缓存（头部插入，保持倒序）
			this.items = [
				{ topicId, agentId, title: null, createdAt: Date.now(), botId: String(botId) },
				...this.items,
			];
			return topicId;
		},

		/**
		 * 删除 topic
		 * @param {string} botId
		 * @param {string} topicId
		 */
		async deleteTopic(botId, topicId) {
			const conn = useBotConnections().get(String(botId));
			if (!conn || conn.state !== 'connected') throw new Error('Bot not connected');
			const result = await conn.request('coclaw.topics.delete', { topicId });
			if (result?.ok === false) throw new Error('Topic not found');
			this.items = this.items.filter((t) => t.topicId !== topicId);
		},

		/**
		 * 更新 topic 元信息（当前仅支持 title）
		 * @param {string} botId
		 * @param {string} topicId
		 * @param {{ title?: string }} changes
		 */
		async updateTopic(botId, topicId, changes) {
			const conn = useBotConnections().get(String(botId));
			if (!conn || conn.state !== 'connected') throw new Error('Bot not connected');
			const result = await conn.request('coclaw.topics.update', { topicId, changes });
			const updated = result?.topic;
			if (!updated) throw new Error('Update failed');
			const idx = this.items.findIndex((t) => t.topicId === topicId);
			if (idx >= 0) {
				this.items[idx] = { ...this.items[idx], ...updated };
				this.items = [...this.items];
			}
		},

		/**
		 * 异步生成 topic 标题（fire-and-forget，不阻塞调用方）
		 * @param {string} botId
		 * @param {string} topicId
		 */
		generateTitle(botId, topicId) {
			const conn = useBotConnections().get(String(botId));
			if (!conn || conn.state !== 'connected') return;
			conn.request('coclaw.topics.generateTitle', { topicId })
				.then((res) => {
					const title = res?.title;
					if (!title) return;
					const idx = this.items.findIndex((t) => t.topicId === topicId);
					if (idx >= 0) {
						this.items[idx] = { ...this.items[idx], title };
						this.items = [...this.items];
					}
				})
				.catch((err) => {
					console.warn('[topics] generateTitle failed:', err);
				});
		},
	},
});
