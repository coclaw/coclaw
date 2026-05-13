/**
 * UI 远程日志去重状态
 *
 * - 内存 Map<uiId, { lastSeq, lastSeenAt }>
 * - 单调 seq 去重：seq <= lastSeq 视为重传，静默丢弃
 * - 不存在的 uiId 视 lastSeq=0（新实例首批 seq=1 自然接受）
 * - 周期定时器扫描清理 1h 无活动条目
 *
 * 详见 docs/designs/remote-log.md。
 */

const UI_LOG_TTL_MS = 60 * 60 * 1000; // 1 小时无活动则清理
const UI_LOG_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟扫一次

const uiState = new Map();

/**
 * 尝试接受一批日志的去重判定。
 * @param {string} uiId
 * @param {number} seq
 * @param {number} [now]
 * @returns {boolean} 接受 → true；重传去重 → false
 */
export function acceptBatch(uiId, seq, now = Date.now()) {
	const cur = uiState.get(uiId);
	const lastSeq = cur?.lastSeq ?? 0;
	if (seq <= lastSeq) {
		// 重传也视为活跃信号，刷新 lastSeenAt 防 TTL 误清；cur 守卫为内部调用兜底
		if (cur) cur.lastSeenAt = now;
		return false;
	}
	uiState.set(uiId, { lastSeq: seq, lastSeenAt: now });
	return true;
}

/**
 * 扫描 map，删除 lastSeenAt 超过 ttl 的条目。
 */
export function pruneStaleEntries(now = Date.now(), ttlMs = UI_LOG_TTL_MS) {
	for (const [uiId, entry] of uiState) {
		if (now - entry.lastSeenAt > ttlMs) {
			uiState.delete(uiId);
		}
	}
}

let cleanupTimer = null;

/**
 * 启动周期定时器；多次调用幂等。
 */
export function startUiLogCleanupTimer(intervalMs = UI_LOG_CLEANUP_INTERVAL_MS) {
	if (cleanupTimer) return;
	cleanupTimer = setInterval(() => pruneStaleEntries(), intervalMs);
	cleanupTimer.unref?.();
}

export function stopUiLogCleanupTimer() {
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}

// 模块加载即启动，.unref() 保证不阻塞 node 退出
startUiLogCleanupTimer();

// 测试辅助：暴露内部 map 与重置/常量；__ 前缀避免与正常 API 混淆
export function __resetUiLogState() {
	uiState.clear();
}

export function __getUiLogState() {
	return uiState;
}

export const __UI_LOG_TTL_MS = UI_LOG_TTL_MS;
export const __UI_LOG_CLEANUP_INTERVAL_MS = UI_LOG_CLEANUP_INTERVAL_MS;
