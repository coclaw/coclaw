import { defineStore } from 'pinia';

import { listWebAgents, recordWebAgentClick } from '../services/web-agents.api.js';

let _loadingPromise = null;

/** 重置模块级 in-flight，方便测试隔离 */
export function __resetWebAgentsInternals() {
	_loadingPromise = null;
}

/**
 * 取较大的 lastClickedAt：null 视为无值
 * @param {string|Date|null|undefined} a
 * @param {string|Date|null|undefined} b
 * @returns {string|Date|null}
 */
function maxLastClickedAt(a, b) {
	if (a == null) return b ?? null;
	if (b == null) return a;
	return new Date(a) >= new Date(b) ? a : b;
}

export const useWebAgentsStore = defineStore('webAgents', {
	state: () => ({
		/** @type {{ id: number, slug: string|null, name: string, url: string, sort: number|null, lastClickedAt: string|Date|null }[]} */
		items: [],
		loaded: false,
		loading: false,
		/** @type {Error|null} */
		error: null,
	}),
	getters: {
		/**
		 * 选择对话框用：所有条目，按 sort 排序（NULL 落最后），sort 同则按 id 升序兜底
		 * @returns {object[]}
		 */
		pickerList(state) {
			return [...state.items].sort((a, b) => {
				const aSort = a.sort ?? Number.MAX_SAFE_INTEGER;
				const bSort = b.sort ?? Number.MAX_SAFE_INTEGER;
				if (aSort !== bSort) return aSort - bSort;
				return a.id - b.id;
			});
		},
		/**
		 * MainList Web Agents 分组用：过滤已点过的，按最近点击降序
		 * @returns {object[]}
		 */
		recentlyClicked(state) {
			return state.items
				.filter((a) => a.lastClickedAt != null)
				.sort((a, b) => new Date(b.lastClickedAt) - new Date(a.lastClickedAt));
		},
	},
	actions: {
		async loadAll() {
			if (_loadingPromise) return _loadingPromise;
			// 已成功加载且非错误态 → 短路返回，避免每次开 dialog 都打一次 GET
			if (this.loaded && !this.error) return;
			this.loading = true;
			this.error = null;
			_loadingPromise = (async () => {
				try {
					const fetched = await listWebAgents();
					// merge：旧 items 的 lastClickedAt 与服务器返回值取较大值，
					// 避免 loadAll 旧响应在 recordClick 之后到达时覆盖乐观更新
					const oldById = new Map(this.items.map((it) => [it.id, it]));
					this.items = fetched.map((it) => {
						const prev = oldById.get(it.id);
						return {
							...it,
							lastClickedAt: prev ? maxLastClickedAt(prev.lastClickedAt, it.lastClickedAt) : (it.lastClickedAt ?? null),
						};
					});
					this.loaded = true;
				}
				catch (err) {
					this.error = err;
					console.warn('[web-agents] loadAll failed:', err?.message ?? err);
				}
				finally {
					this.loading = false;
				}
			})();
			try {
				await _loadingPromise;
			}
			finally {
				_loadingPromise = null;
			}
		},

		/**
		 * 记录一次点击：本地乐观更新 + fire-and-forget 上报
		 * @param {number} id
		 */
		recordClick(id) {
			const item = this.items.find((it) => it.id === id);
			if (item) {
				item.lastClickedAt = new Date().toISOString();
			}
			recordWebAgentClick(id).catch((err) => {
				console.warn('[web-agents] recordClick failed id=%s:', id, err?.message ?? err);
			});
		},
	},
});
