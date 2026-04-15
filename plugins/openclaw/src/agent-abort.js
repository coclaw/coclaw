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
const REPLY_RUN_STATE_KEY = Symbol.for('openclaw.replyRunRegistry');

/**
 * 从 reply-run-registry 全局单例中解析 sessionId → sessionKey 映射及概览，
 * 用于 not-found 分支的诊断输出——辅助判断 run 尚未注册（空窗期）还是 sessionKey 对应错误。
 * @param {string} sessionId
 * @returns {string}
 */
function describeReplyRunRegistry(sessionId) {
	const state = globalThis[REPLY_RUN_STATE_KEY];
	if (!state) return 'reply.state=absent';
	const parts = [];
	const runs = state.activeRunsByKey;
	if (runs && typeof runs.size === 'number') {
		parts.push(`reply.activeRunsByKey.size=${runs.size}`);
		try {
			const ks = [];
			if (typeof runs.keys === 'function') {
				for (const k of runs.keys()) {
					ks.push(k);
					if (ks.length >= 10) break;
				}
			}
			parts.push(`reply.keys=${JSON.stringify(ks)}`);
		}
		catch (e) {
			parts.push(`reply.keysErr=${String(e?.message ?? e)}`);
		}
	}
	else {
		parts.push('reply.activeRunsByKey=absent');
	}
	const byId = state.activeKeysBySessionId;
	if (byId && typeof byId.get === 'function') {
		try {
			const mapped = byId.get(sessionId);
			parts.push(`reply.keyForSid=${mapped === undefined ? 'null' : JSON.stringify(mapped)}`);
		}
		catch (e) {
			parts.push(`reply.keyForSidErr=${String(e?.message ?? e)}`);
		}
	}
	else {
		parts.push('reply.activeKeysBySessionId=absent');
	}
	return parts.join(' ');
}

/**
 * 尝试取消 sessionId 对应的 embedded agent run
 * @param {string} sessionId
 * @param {{ info?: Function }} [logger] - 可选 logger；传入时在 not-found 分支 dump activeRuns 诊断信息
 * @returns {{ ok: true } | { ok: false, reason: 'not-supported' | 'not-found' | 'abort-threw', error?: string }}
 */
export function abortAgentRun(sessionId, logger) {
	const state = globalThis[EMBEDDED_RUN_STATE_KEY];
	if (!state || !state.activeRuns || typeof state.activeRuns.get !== 'function') {
		return { ok: false, reason: 'not-supported' };
	}
	try {
		const handle = state.activeRuns.get(sessionId);
		if (!handle) {
			if (logger?.info) {
				let diag = `sessionId=${sessionId} embedded.size=${state.activeRuns.size ?? '?'}`;
				try {
					const ks = [];
					if (typeof state.activeRuns.keys === 'function') {
						for (const k of state.activeRuns.keys()) {
							ks.push(k);
							if (ks.length >= 10) break;
						}
					}
					diag += ` embedded.keys=${JSON.stringify(ks)}`;
				}
				catch (e) {
					diag += ` embedded.keysErr=${String(e?.message ?? e)}`;
				}
				diag += ` ${describeReplyRunRegistry(sessionId)}`;
				logger.info(`[coclaw.agent.abort] not-found diag ${diag}`);
			}
			return { ok: false, reason: 'not-found' };
		}
		// shape 守卫：abort 字段应为函数；若不是说明 OpenClaw handle 契约变化（归入 not-supported 让 UI 提示升级）
		if (typeof handle.abort !== 'function') return { ok: false, reason: 'not-supported' };
		handle.abort();
		return { ok: true };
	}
	catch (err) {
		// activeRuns.get() 或 handle.abort() 抛（非 Map 实现 / OpenClaw 内部错误）
		return { ok: false, reason: 'abort-threw', error: String(err?.message ?? err) };
	}
}
