/**
 * ClawConnection 实例管理器（全局单例）
 * 管理所有 per-claw DC 连接实例的生命周期。
 * WS 信令已迁移至 SignalingConnection（per-tab 单例）。
 */
import { ClawConnection } from './claw-connection.js';
import { useSignalingConnection } from './signaling-connection.js';

let instance = null;

class ClawConnectionManager {
	constructor() {
		/** @type {Map<string, ClawConnection>} */
		this.__connections = new Map();
	}

	/**
	 * 为指定 claw 创建连接实例（幂等：已存在则返回现有实例）
	 * @param {string} clawId
	 * @returns {ClawConnection}
	 */
	connect(clawId) {
		const key = String(clawId);
		const existing = this.__connections.get(key);
		if (existing) return existing;
		console.debug('[ClawConnMgr] connect clawId=%s', key);
		const conn = new ClawConnection(key);
		this.__connections.set(key, conn);
		return conn;
	}

	/**
	 * 断开指定 claw 连接
	 * @param {string} clawId
	 */
	disconnect(clawId) {
		const key = String(clawId);
		const conn = this.__connections.get(key);
		if (!conn) return;
		console.debug('[ClawConnMgr] disconnect clawId=%s', key);
		conn.disconnect();
		this.__connections.delete(key);
	}

	/**
	 * 获取指定 claw 的连接实例
	 * @param {string} clawId
	 * @returns {ClawConnection | undefined}
	 */
	get(clawId) {
		return this.__connections.get(String(clawId));
	}

	/**
	 * 同步连接列表：连接新增的 claw，断开已移除的 claw
	 * @param {string[]} clawIds - 当前需要连接的 claw ID 列表
	 */
	syncConnections(clawIds) {
		const desired = new Set(clawIds.map(String));
		console.debug('[ClawConnMgr] sync desired=%o current=%o', [...desired], [...this.__connections.keys()]);
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
		console.debug('[ClawConnMgr] disconnectAll count=%d', this.__connections.size);
		for (const key of [...this.__connections.keys()]) {
			this.disconnect(key);
		}
	}

	/**
	 * 获取所有连接的状态（统一返回信令 WS 的全局状态）
	 * @returns {Object<string, string>}
	 */
	getStates() {
		const sigState = useSignalingConnection().state;
		const states = {};
		for (const key of this.__connections.keys()) {
			states[key] = sigState;
		}
		return states;
	}

	/** @returns {number} 当前连接数 */
	get size() {
		return this.__connections.size;
	}
}

/**
 * 获取全局 ClawConnectionManager 单例
 * @returns {ClawConnectionManager}
 */
export function useClawConnections() {
	if (!instance) {
		instance = new ClawConnectionManager();
	}
	return instance;
}

/**
 * 重置单例（仅测试用）
 */
export function __resetClawConnections() {
	if (instance) {
		instance.disconnectAll();
		instance = null;
	}
}

export { ClawConnectionManager };
