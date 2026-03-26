import { defineStore } from 'pinia';

import { isCapacitorApp } from '../utils/platform.js';
import { useAuthStore } from './auth.store.js';

const STORAGE_KEY_PREFIX = 'coclaw:drafts';

/** 按平台选择存储后端：Capacitor 用 localStorage（进程被 kill 后可恢复），浏览器用 sessionStorage（多窗口隔离 + 隐私） */
function getStorage() {
	return isCapacitorApp ? localStorage : sessionStorage;
}

/** 带 userId 隔离的 storage key */
function getStorageKey() {
	const userId = useAuthStore().user?.id;
	return userId ? `${STORAGE_KEY_PREFIX}:${userId}` : STORAGE_KEY_PREFIX;
}

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

		/** 序列化到存储 */
		persist() {
			try {
				const storage = getStorage();
				const key = getStorageKey();
				const entries = Object.entries(this.drafts).filter(([, v]) => v);
				if (entries.length > 0) {
					storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
				}
				else {
					storage.removeItem(key);
				}
			}
			catch { /* quota exceeded 等异常静默 */ }
		},

		/** 从存储恢复 */
		restore() {
			try {
				const storage = getStorage();
				const key = getStorageKey();
				const raw = storage.getItem(key);
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

		/** 注册持久化钩子 */
		initPersist() {
			if (this.__persistBound) return;
			this.__persistBound = true;

			window.addEventListener('beforeunload', () => this.persist());
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') this.persist();
			});
			// Capacitor 上 visibilitychange 不一定可靠，补充 app:background
			window.addEventListener('app:background', () => this.persist());

			// 初始化时立即恢复
			this.restore();
		},

		/**
		 * 用户身份变更后重新加载草稿（登录/切换用户）
		 * 清空当前内存态后从新 userId 的存储恢复
		 */
		onUserChanged() {
			this.drafts = {};
			this.restore();
		},
	},
});
