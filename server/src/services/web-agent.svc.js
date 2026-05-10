import {
	findVisibleAgentId,
	incrementClick,
	setHiddenNow,
} from '../repos/web-agent.repo.js';

/**
 * 记录一次点击。返回 boolean：
 * - true  → 已记录（route handler 返 204）
 * - false → 不可见 / 不存在（route handler 返 404）
 *
 * 设计上"并发首次点击"可能触发 prisma upsert 的双 create 路径产生 P2002，
 * 第一版按已知容忍处理（设计第六章），不在此层吞 P2002。
 */
export async function recordClick({ userId, webAgentId }, deps = {}) {
	const {
		findVisibleAgentIdImpl = findVisibleAgentId,
		incrementClickImpl = incrementClick,
	} = deps;

	const id = await findVisibleAgentIdImpl({ userId, webAgentId });
	if (id == null) {
		return false;
	}

	await incrementClickImpl({ userId, webAgentId });
	return true;
}

/**
 * 将某 Web Agent 从当前用户的最近列表隐藏（设置 hiddenAt = now）。返回 boolean：
 * - true  → 已隐藏（route handler 返 204）
 * - false → Agent 不可见 / 用户从未点击过该 Agent（route handler 返 404）
 *
 * 重复隐藏幂等：每次都将 hiddenAt 刷成最新时间。
 */
export async function hide({ userId, webAgentId }, deps = {}) {
	const {
		findVisibleAgentIdImpl = findVisibleAgentId,
		setHiddenNowImpl = setHiddenNow,
	} = deps;

	const id = await findVisibleAgentIdImpl({ userId, webAgentId });
	if (id == null) {
		return false;
	}

	const affected = await setHiddenNowImpl({ userId, webAgentId });
	return affected > 0;
}
