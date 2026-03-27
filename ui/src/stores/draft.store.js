import { defineStore } from 'pinia';

const STORAGE_KEY = 'coclaw:drafts';

export const useDraftStore = defineStore('draft', {
	state: () => ({
		/** @type {Record<string, string>} key → 草稿文本 */
		drafts: {},
		/** @type {boolean} 防止重复注册事件 */
		__persistBound: false,
	}),
	actions: {
		/**
		 * 获取草稿
		 * @param {string} key - 草稿 key
		 * @returns {string}
		 */
		getDraft(key) {
			return this.drafts[key] ?? '';
		},

		/**
		 * 写入草稿（空字符串等同于清除）
		 * @param {string} key - 草稿 key
		 * @param {string} text - 草稿文本
		 */
		setDraft(key, text) {
			if (!key) return;
			if (text) {
				this.drafts[key] = text;
			}
			else {
				delete this.drafts[key];
			}
		},

		/**
		 * 清除指定草稿
		 * @param {string} key - 草稿 key
		 */
		clearDraft(key) {
			delete this.drafts[key];
		},

		/** 序列化到 sessionStorage */
		persist() {
			try {
				const entries = Object.entries(this.drafts).filter(([, v]) => v);
				if (entries.length > 0) {
					sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
				}
				else {
					sessionStorage.removeItem(STORAGE_KEY);
				}
			}
			catch { /* quota exceeded 等异常静默 */ }
		},

		/** 从 sessionStorage 恢复 */
		restore() {
			try {
				const raw = sessionStorage.getItem(STORAGE_KEY);
				if (!raw) return;
				const data = JSON.parse(raw);
				if (data && typeof data === 'object') {
					// 仅恢复非空字符串
					for (const [k, v] of Object.entries(data)) {
						if (typeof v === 'string' && v) {
							this.drafts[k] = v;
						}
					}
				}
			}
			catch { /* JSON 解析失败等静默 */ }
		},

		/** 注册 beforeunload / visibilitychange 持久化钩子 */
		initPersist() {
			if (this.__persistBound) return;
			this.__persistBound = true;

			window.addEventListener('beforeunload', () => this.persist());
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') this.persist();
			});

			// 初始化时立即恢复
			this.restore();
		},
	},
});
