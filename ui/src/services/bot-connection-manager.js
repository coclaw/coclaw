/**
 * BotConnection 实例管理器（全局单例）
 * 管理所有 per-bot 持久 WS 连接的生命周期
 */
import { BotConnection } from './bot-connection.js';

let instance = null;

class BotConnectionManager {
	constructor() {
		/** @type {Map<string, BotConnection>} */
		this.__connections = new Map();
	}

	/**
	 * 为指定 bot 建立连接（幂等：已存在则返回现有实例）
	 * @param {string} botId
	 * @param {object} [options] - 传递给 BotConnection 构造函数
	 * @returns {BotConnection}
	 */
	connect(botId, options) {
		const key = String(botId);
		const existing = this.__connections.get(key);
		if (existing) return existing;
		const conn = new BotConnection(key, options);
		this.__connections.set(key, conn);
		conn.connect();
		return conn;
	}

	/**
	 * 断开指定 bot 连接
	 * @param {string} botId
	 */
	disconnect(botId) {
		const key = String(botId);
		const conn = this.__connections.get(key);
		if (!conn) return;
		conn.disconnect();
		this.__connections.delete(key);
	}

	/**
	 * 获取指定 bot 的连接实例
	 * @param {string} botId
	 * @returns {BotConnection | undefined}
	 */
	get(botId) {
		return this.__connections.get(String(botId));
	}

	/**
	 * 同步连接列表：连接新增的 bot，断开已移除的 bot
	 * @param {string[]} botIds - 当前需要连接的 bot ID 列表
	 */
	syncConnections(botIds) {
		const desired = new Set(botIds.map(String));
		// 断开不再需要的
		for (const key of [...this.__connections.keys()]) {
			if (!desired.has(key)) {
				this.disconnect(key);
			}
		}
		// 连接新增的
		for (const id of desired) {
			if (!this.__connections.has(id)) {
				this.connect(id);
			}
		}
	}

	/** 断开所有连接 */
	disconnectAll() {
		for (const key of [...this.__connections.keys()]) {
			this.disconnect(key);
		}
	}

	/**
	 * 获取所有连接的状态
	 * @returns {Object<string, string>}
	 */
	getStates() {
		const states = {};
		for (const [key, conn] of this.__connections) {
			states[key] = conn.state;
		}
		return states;
	}

	/** @returns {number} 当前连接数 */
	get size() {
		return this.__connections.size;
	}
}

/**
 * 获取全局 BotConnectionManager 单例
 * @returns {BotConnectionManager}
 */
export function useBotConnections() {
	if (!instance) {
		instance = new BotConnectionManager();
	}
	return instance;
}

/**
 * 重置单例（仅测试用）
 */
export function __resetBotConnections() {
	if (instance) {
		instance.disconnectAll();
		instance = null;
	}
}

export { BotConnectionManager };
