/**
 * agent-cancel-heuristic：取消请求的启发式判定
 *
 * OpenClaw 侧门 abort 返回 not-found 时，单凭这个信号无法区分两种状态：
 *   1. 注册空窗：UI 已发 send，但 OpenClaw 还没把 run 注册到 activeRuns
 *      → UI 应继续 tick 重试，等注册完成
 *   2. run 已实际结束/丢失但终态信号未送达 UI（compaction-retry 边界、
 *      上游 lifecycle:end 漏发、网络丢包等）
 *      → UI 应主动收尾，避免无限 tick
 *
 * 用 UI 透传的两个墙钟时长做"双闸"启发：
 *   - runDuration ≥ 3min：从 onAccepted 到现在；正常 run 不会这么久仍在跑
 *   - abortDuration ≥ 1min：从首次 STOP 到现在；正常 run 在 1min 内能响应取消
 * 双闸都满足才升格为 'gone'，告知 UI 主动 settleByCancel + 提示用户。
 *
 * 阈值偏保守，宁可让 UI 多 tick 几次也不误升格。
 *
 * 兼容旧 UI：旧 UI 不传 runDuration/abortDuration，ctx 字段为 undefined，
 * 双闸永远不命中，行为退化为原样透传 not-found（与无启发时一致）。
 */

export const RUN_DURATION_GONE_THRESHOLD_MS = 3 * 60 * 1000;
export const ABORT_DURATION_GONE_THRESHOLD_MS = 60 * 1000;

/**
 * 根据侧门 abort 结果 + UI 上下文决定最终响应
 * @param {object} abortResult - abortAgentRun 的返回值
 * @param {object} [ctx] - { runDuration, abortDuration }（毫秒），旧 UI 不传时为 undefined
 * @returns {object} 透传或升格后的响应（保持 abortResult 同形 shape）
 */
export function decideCancelResponse(abortResult, ctx) {
	// ok 与非 not-found 原因（not-supported / abort-threw 等）原样透传
	if (abortResult.ok) return abortResult;
	if (abortResult.reason !== 'not-found') return abortResult;

	const runDur = ctx?.runDuration;
	const abortDur = ctx?.abortDuration;
	const runHit = typeof runDur === 'number' && Number.isFinite(runDur) && runDur >= RUN_DURATION_GONE_THRESHOLD_MS;
	const abortHit = typeof abortDur === 'number' && Number.isFinite(abortDur) && abortDur >= ABORT_DURATION_GONE_THRESHOLD_MS;
	if (runHit && abortHit) return { ok: false, reason: 'gone' };
	return abortResult;
}
