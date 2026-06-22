/**
 * 归一化 RPC / DC 请求里的 agentId。
 *
 * 缺省（undefined / null）回落到默认 agent 'main'；空串 / 纯空白同样回落到 'main'（保持
 * 既有 `X?.agentId?.trim?.() || 'main'` 契约）。但**非字符串**（number / object / bool /
 * array 等）视为非法输入并响亮抛错——静默落 'main' 会让读站点跨 workspace 泄露文件列表/内容、
 * 写站点误改默认 agent 的数据。
 *
 * 抛出的 Error 带 `.code = 'INVALID_INPUT'`，由各 handler 的外层 catch（index.js 的
 * respondError / file-manager 的 sendError）浮现为结构化错误码。
 *
 * @param {{ agentId?: unknown }} [params] - 请求参数容器（index.js 的 params / handler.js 的 req）
 * @returns {string} 归一化后的 agentId
 */
export function normalizeAgentId(params) {
	const raw = params?.agentId;
	if (raw === undefined || raw === null) return 'main';
	if (typeof raw !== 'string') {
		const err = new Error('agentId must be a string');
		err.code = 'INVALID_INPUT';
		throw err;
	}
	return raw.trim() || 'main'; // 空串 / 纯空白 → 'main'
}
