import { defineStore } from 'pinia';

import { hideWebAgent, listWebAgents, recordWebAgentClick } from '../services/web-agents.api.js';
import { useAuthStore } from './auth.store.js';

let _loadingPromise = null;
// 用户身份切换 / 测试隔离时自增；loadAll 启动时捕获，await 后 epoch 不等表示
// 这次响应已属于"旧身份"，应丢弃，避免登出后 in-flight 旧数据把刚 $reset 的 store 复活
let _resetEpoch = 0;

/** 重置模块级 in-flight + 自增 epoch（让在飞的 loadAll 响应被丢弃） */
export function __resetWebAgentsInternals() {
	_resetEpoch++;
	_loadingPromise = null;
}

/**
 * 取较大的时间戳：null 视为无值
 * @param {string|Date|null|undefined} a
 * @param {string|Date|null|undefined} b
 * @returns {string|Date|null}
 */
function maxTimestamp(a, b) {
	if (a == null) return b ?? null;
	if (b == null) return a;
	return new Date(a) >= new Date(b) ? a : b;
}

export const useWebAgentsStore = defineStore('webAgents', {
	state: () => ({
		/** @type {{ id: number, slug: string|null, name: string, url: string, sort: number|null, lastClickedAt: string|Date|null, hiddenAt: string|Date|null }[]} */
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
		 * MainList Web Agents 分组用：过滤已点过且未隐藏的，按最近点击降序
		 * @returns {object[]}
		 */
		recentlyClicked(state) {
			return state.items
				.filter((a) => a.lastClickedAt != null && a.hiddenAt == null)
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
			const epoch = _resetEpoch;
			const myPromise = (async () => {
				try {
					const fetched = await listWebAgents();
					// epoch 不一致：登出/换号已发生，本次响应属于旧身份，整段丢弃
					if (epoch !== _resetEpoch) return;
					// merge：用本地 prev 与服务器值合并，避免 loadAll 旧响应在 recordClick / hide
					// 之后到达时覆盖乐观更新。
					// hiddenAt 语义：click 事件总会清掉 hiddenAt，hide 事件总会写入 hiddenAt。
					// 所以"现在是否处于隐藏态"取决于 max(local hide, server hide) 与 max(local click, server click)
					// 哪个更晚——晚的那个事件代表用户最后的意图：
					//   - 最晚 hide 严格晚于最晚 click → 还在隐藏
					//   - 否则 → 一次更晚的 click 已经把 hide 清了，回到可见
					const oldById = new Map(this.items.map((it) => [it.id, it]));
					this.items = fetched.map((it) => {
						const prev = oldById.get(it.id);
						const lastClickedAt = prev
							? maxTimestamp(prev.lastClickedAt, it.lastClickedAt)
							: (it.lastClickedAt ?? null);
						const candidateHide = maxTimestamp(prev?.hiddenAt, it.hiddenAt);
						let hiddenAt = candidateHide ?? null;
						if (hiddenAt != null && lastClickedAt != null
							&& new Date(hiddenAt) <= new Date(lastClickedAt)) {
							hiddenAt = null;
						}
						return { ...it, lastClickedAt, hiddenAt };
					});
					this.loaded = true;
				}
				catch (err) {
					if (epoch !== _resetEpoch) return;
					this.error = err;
					console.warn('[web-agents] loadAll failed:', err?.message ?? err);
				}
				finally {
					// 仅在 epoch 仍为本次时清 loading；否则新 loadAll 已把 loading 设为 true，旧 IIFE 不能踩
					if (epoch === _resetEpoch) this.loading = false;
				}
			})();
			_loadingPromise = myPromise;
			try {
				await myPromise;
			}
			finally {
				// 仅清除自己装的 promise——若期间 reset 把 _loadingPromise 清成 null 且新 loadAll 已挂上 P2，
				// 这里再写 null 会把 P2 的 handle 错置，导致后续并行 IIFE
				if (_loadingPromise === myPromise) _loadingPromise = null;
			}
		},

		/**
		 * 记录一次点击：本地乐观更新 + fire-and-forget 上报
		 * 同步把 hiddenAt 清成 null（再点取消隐藏，与服务器最终状态对齐）
		 * 未登录用户：整段跳过——web agent 仅作为"入口"打开外链，不进 MainList、不打 server
		 * @param {number} id
		 */
		recordClick(id) {
			if (!useAuthStore().user) return;
			const item = this.items.find((it) => it.id === id);
			if (item) {
				item.lastClickedAt = new Date().toISOString();
				item.hiddenAt = null;
			}
			recordWebAgentClick(id).catch((err) => {
				console.warn('[web-agents] recordClick failed id=%s:', id, err?.message ?? err);
			});
		},

		/**
		 * 从最近列表移除：本地乐观把 hiddenAt 标为现在 + fire-and-forget 上报
		 * 未登录用户：整段跳过（与 recordClick 对称）
		 * @param {number} id
		 */
		hide(id) {
			if (!useAuthStore().user) return;
			const item = this.items.find((it) => it.id === id);
			if (item) {
				item.hiddenAt = new Date().toISOString();
			}
			hideWebAgent(id).catch((err) => {
				console.warn('[web-agents] hide failed id=%s:', id, err?.message ?? err);
			});
		},
	},
});
