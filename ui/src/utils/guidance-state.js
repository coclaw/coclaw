/**
 * 选出某台 claw 当前最该提示的"模型配置引导"状态（设计 § 6）。
 *
 * 三种状态互斥，按严重度优先级 1 > 2 > 3 取最严重者：
 *   1. 没有任何凭据         → 'noKey'      （未配 API key）
 *   2. 有凭据但没设主模型   → 'noPrimary'  （未配主模型）
 *   3. 设了主模型但已失效   → 'invalid'    （主模型失效）
 * 三者都不命中（凭据齐、主模型有效）→ null（不提示）。
 *
 * 注意：这是纯函数，只看传入的派生值，不做"数据是否拿到"的判断——
 * 调用方需在调用前自行 gate（claw 在线 + RPC 真的返回了），否则失败态的
 * 默认值（false/null/false）会被误判成 'noKey'。
 *
 * @param {{ hasAny: boolean, primary: string|null, effective: boolean }} input
 *   - hasAny: 是否绑了至少一个 provider 凭据
 *   - primary: 当前主模型字符串（未设为 null）
 *   - effective: 当前主模型是否有效
 * @returns {'noKey'|'noPrimary'|'invalid'|null}
 */
export function pickGuidanceState({ hasAny, primary, effective } = {}) {
	if (!hasAny) return 'noKey';
	if (!primary) return 'noPrimary';
	if (!effective) return 'invalid';
	return null;
}
