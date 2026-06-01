/**
 * 把模型 id 拆成 provider / model 两段，供「provider 一行、model 一行」分行展示。
 *
 * 规则（与原 ModelConfigPage.primaryParsed 对齐，作为三处调用的唯一来源）：
 *   - 空串 / 非字符串 → null
 *   - 无有效 '/'（无分隔，或分隔落在首/尾）→ { provider: '', model: id } 兜底（整串当 model，不丢信息）
 *   - 正常 'a/b'（含 'a/b/c' 只按第一个 '/' 拆）→ { provider, model }
 *
 * @param {string} id - 模型 id，如 'groq/llama-3.3-70b'
 * @returns {{ provider: string, model: string }|null}
 */
export function parseModelId(id) {
	if (!id || typeof id !== 'string') return null;
	const idx = id.indexOf('/');
	if (idx <= 0 || idx === id.length - 1) return { provider: '', model: id };
	return { provider: id.slice(0, idx), model: id.slice(idx + 1) };
}
