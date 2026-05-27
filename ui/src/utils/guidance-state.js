/**
 * 选出某台 claw 当前最该提示的"模型配置引导"状态（设计 § 6 / § 7.4）。
 *
 * 三种状态互斥，按严重度优先级 1 > 2 > 3 取最严重者：
 *   1. 没有任何可用凭据     → 'noKey'      （未配 API key）
 *   2. 有凭据但没设主模型   → 'noPrimary'  （未配主模型）
 *   3. 设了主模型但那家失效 → 'invalid'    （主模型失效，只看凭据）
 * 三者都不命中（凭据齐、主模型那家有凭据）→ null（不提示）。
 *
 * 凭据信号由插件计算（hasAny / effective）。旧插件给不出 → credSignalKnown=false，
 * 此时凭据信号未知：noKey / invalid 一律不报，只保留靠 primary 是否为空判定的 noPrimary
 * （宁可少提示，绝不对正常 claw 误报）。这条"是否压制"必须嵌进优先级里——noKey 优先级最高，
 * 若放到调用方事后压制会把本该显示的 noPrimary 也一起吞掉。
 *
 * 注意：这是纯函数，只看传入的派生值，不做"数据是否拿到"的判断——
 * 调用方仍需在调用前自行 gate（claw 在线 + 凭据 RPC 真的返回了）。
 *
 * @param {{ hasAny: boolean, primary: string|null, effective: boolean, credSignalKnown?: boolean }} input
 *   - hasAny: 是否有至少一个可用凭据（插件 hasAnyUsableCredential）
 *   - primary: 当前主模型字符串（未设为 null）
 *   - effective: 主模型那家是否有可用凭据（插件 default.providerUsable）
 *   - credSignalKnown: 凭据信号是否可用（旧插件给不出时为 false），默认 true
 * @returns {'noKey'|'noPrimary'|'invalid'|null}
 */
export function pickGuidanceState({ hasAny, primary, effective, credSignalKnown = true } = {}) {
	if (credSignalKnown && !hasAny) return 'noKey';
	if (!primary) return 'noPrimary';
	if (credSignalKnown && !effective) return 'invalid';
	return null;
}
