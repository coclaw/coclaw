/**
 * OC sessions.get 返回扁平消息（{ role, content, model, timestamp, ... }），
 * 包装为 UI 消息管线所需的 JSONL 行级结构（{ type, id, message }）。
 *
 * OC 的 readSessionMessages 只保留 parsed.message 子对象，丢弃外层 type 和 id。
 * 此函数补回这两个字段，使输出与 coclaw.sessions.getById 和旧 nativeui.sessions.get 格式一致。
 *
 * @param {object[]} flatMessages - OC sessions.get 返回的消息数组
 * @returns {object[]} JSONL 行级结构
 */
function wrapOcMessages(flatMessages) {
	if (!Array.isArray(flatMessages)) return [];
	return flatMessages.map((msg, i) => ({
		type: 'message',
		id: `oc-${i}`,
		message: msg,
	}));
}

export { wrapOcMessages };
