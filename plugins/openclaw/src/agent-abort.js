/**
 * agent-abort：封装 OpenClaw embedded agent run 的侧门取消入口
 *
 * OpenClaw 自 v2026.3.12 起通过全局 symbol 注册表暴露 activeRuns 映射，
 * 允许外部根据 sessionId 调 handle.abort() 真正终止正在执行的 agent run
 *（LLM + 工具 + compaction 均受影响）。
 *
 * 本模块是 CoClaw 插件访问该侧门的唯一入口，未来上游提供正式 API 时集中替换。
 */

const EMBEDDED_RUN_STATE_KEY = Symbol.for('openclaw.embeddedRunState');

/**
 * 尝试取消 sessionId 对应的 embedded agent run
 * @param {string} sessionId
 * @returns {{ ok: true } | { ok: false, reason: 'not-supported' | 'not-found' | 'abort-threw', error?: string }}
 */
export function abortAgentRun(sessionId) {
	const state = globalThis[EMBEDDED_RUN_STATE_KEY];
	if (!state || !state.activeRuns || typeof state.activeRuns.get !== 'function') {
		return { ok: false, reason: 'not-supported' };
	}
	const handle = state.activeRuns.get(sessionId);
	if (!handle) return { ok: false, reason: 'not-found' };
	try {
		handle.abort();
		return { ok: true };
	}
	catch (err) {
		return { ok: false, reason: 'abort-threw', error: String(err?.message ?? err) };
	}
}
