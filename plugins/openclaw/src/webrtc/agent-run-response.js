/**
 * 判断一条 JSON 字符串是否为带 runId 的 RPC 响应（队列满时白名单豁免谓词）。
 *
 * 命中条件（仅看顶层）：`type === 'res'` 且 `payload.runId` 为 truthy。
 * 设计取舍：硬编码识别、不维护方法白名单表。该条件主要为覆盖 OpenClaw `agent` 二阶段 res
 * 与 `agent.wait` 全部分支（accepted/ok/error/timeout/race/dedupe）；同时也会顺带豁免
 * `chat.send` 等其他顶层带 `runId` 的响应——这类 rsp 极小，加白无副作用。
 * 解析失败或不命中按非白名单处理。
 *
 * @param {string} jsonStr - 待发送的 RPC 帧 JSON 字符串
 * @returns {boolean} 命中白名单返回 true；解析失败或不命中返回 false
 */
export function isAgentRunResponse(jsonStr) {
	try {
		const parsed = JSON.parse(jsonStr);
		return parsed?.type === 'res' && Boolean(parsed?.payload?.runId);
	} catch {
		return false;
	}
}
