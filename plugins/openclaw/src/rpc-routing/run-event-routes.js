/**
 * runId → connId 路由表（已集成于 realtime-bridge）
 *
 * 用途：把 OpenClaw gateway 推来的 `event:agent` 帧按 runId 单播给真正发起这个 run 的 DC，
 * 避免多 PC 场景下"广播给所有连过来的 rpc DC"导致死 PC 也收到的问题。
 *
 * 设计要点：
 * - 构造函数纯组装，无副作用；起 timer 走 init()，停 timer 走 destroy()
 * - destroy 后 add / remove / lookup / clear / init 全是 no-op
 * - add 写入策略：runId 不在表写入；同 reqId 刷新 expireAt；不同 reqId 跳过覆盖（首发优先）
 * - remove 删除策略：runId 在表 + entry.reqId === 入参 reqId 才删（防跨 RPC 巧合 runId 误删）
 * - lookup hot path：不顺手清过期，TTL 由 scan timer 负责
 * - scan 整段 try/catch 兜底，logger 抛错也不能击穿 gateway 进程
 * - timer 必须 unref()——避免 hold 进程退出
 *
 * 与 reqId 路由表（realtime-bridge.js __dcPendingRequests）保持行为对齐：
 * 对 PC 关闭和网关 WS 翻转都不做联动清理（外/内/P2P 三线独立），TTL 兜底；
 * 仅显式销毁路径（bridge.stop / refresh）会通过 destroy() 清表。
 */

/** 路由条目最大存活时间（24h），与 reqId 表对齐 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 整表周期扫描间隔（1h），与 reqId 表对齐 */
export const DEFAULT_SCAN_MS = 60 * 60 * 1000;

export class RunEventRoutes {
	/**
	 * @param {object} [opts]
	 * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [opts.logger=console]
	 * @param {number} [opts.ttlMs=DEFAULT_TTL_MS]
	 * @param {number} [opts.scanMs=DEFAULT_SCAN_MS]
	 */
	constructor({ logger, ttlMs, scanMs } = {}) {
		this.logger = logger ?? console;
		this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
		this.scanMs = scanMs ?? DEFAULT_SCAN_MS;
		/** @type {Map<string, { connId: string, reqId: string, expireAt: number }>} */
		this.__entries = new Map();
		this.__scanTimer = null;
		this.__destroyed = false;
	}

	/** 起周期扫描 timer。重入安全：已 init / 已 destroy 均 no-op */
	init() {
		if (this.__destroyed) return;
		if (this.__scanTimer) return;
		this.__scanTimer = setInterval(() => this.__scanExpired(), this.scanMs);
		this.__scanTimer.unref?.();
	}

	/**
	 * 添加路由条目。任一参数 falsy 静默返回（防御性）。
	 * @param {string} runId
	 * @param {string} connId
	 * @param {string} reqId
	 */
	add(runId, connId, reqId) {
		if (this.__destroyed) return;
		if (!runId || !connId || !reqId) return;
		const existing = this.__entries.get(runId);
		const expireAt = Date.now() + this.ttlMs;
		if (existing && existing.reqId !== reqId) {
			// 已被首发占用，跳过覆盖（防 attach 抢路由）。debug 日志便于观察。
			// logger.debug 自身抛错也不能让 add 失败（与 __scanExpired 内的 try/catch 风格一致）
			try { this.logger.debug?.(`[run-event-routes] add skipped: runId already routed by reqId=${existing.reqId} new reqId=${reqId}`); }
			catch { /* logger 自身坏了不能让 add 抛 */ }
			return;
		}
		// 同 reqId 重发：仅刷新 expireAt，connId 锁死在首发值（首发优先的彻底化）
		if (existing) {
			existing.expireAt = expireAt;
			return;
		}
		this.__entries.set(runId, { connId, reqId, expireAt });
	}

	/**
	 * 移除路由条目。runId 在表且 entry.reqId === 入参 reqId 才删。
	 * @param {string} runId
	 * @param {string} reqId
	 */
	remove(runId, reqId) {
		if (this.__destroyed) return;
		if (!runId || !reqId) return;
		const entry = this.__entries.get(runId);
		if (!entry) return;
		if (entry.reqId !== reqId) return;
		this.__entries.delete(runId);
	}

	/**
	 * 查路由 → connId 或 undefined。不顺手清过期。
	 * @param {string} runId
	 * @returns {string | undefined}
	 */
	lookup(runId) {
		if (this.__destroyed) return undefined;
		if (!runId) return undefined;
		const entry = this.__entries.get(runId);
		return entry?.connId;
	}

	/** 整表清空。不动 timer（语义=网关 WS 断开后清表，保留 scan 给后续 init 用）*/
	clear() {
		if (this.__destroyed) return;
		this.__entries.clear();
	}

	/** 停 timer + clear + 标 destroyed。幂等。*/
	destroy() {
		if (this.__destroyed) return;
		this.__destroyed = true;
		if (this.__scanTimer) {
			clearInterval(this.__scanTimer);
			this.__scanTimer = null;
		}
		this.__entries.clear();
	}

	/** 内部扫描过期条目；try/catch 兜底，避免 timer 回调异常击穿 gateway 进程 */
	__scanExpired() {
		try {
			const now = Date.now();
			let cleaned = 0;
			for (const [runId, entry] of this.__entries) {
				if (entry.expireAt <= now) {
					this.__entries.delete(runId);
					cleaned += 1;
				}
			}
			if (cleaned > 0) {
				this.logger.warn?.(`[run-event-routes] expired entries cleaned: count=${cleaned}`);
			}
		}
		catch {
			// 扫描器自身异常静默吞掉，避免拖垮 gateway（如 logger.warn 抛错）
		}
	}
}
