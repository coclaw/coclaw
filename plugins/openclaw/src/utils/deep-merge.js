/**
 * deep-merge.js —— 把 patch 递归并入 target（就地修改）
 *
 * 语义（与上游 config patch 合并对齐 openclaw-repo/src/plugins/provider-auth-choice-helpers.ts
 * 的 mergeConfigPatch）：
 * - 两边都是 plain object → 递归并入；
 * - 否则（数组 / 原始值 / null）→ patch 值直接覆盖；
 * - 原型污染键（__proto__ / constructor / prototype）一律跳过。
 *
 * 用途：provider 登录返回的 configPatch（Partial<OpenClawConfig>）合并进 mutateConfigFile 的
 * draft——不能裸 Object.assign（会把 models / agents 整段顶掉），必须逐层深合并保留其它 provider。
 */

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把 patch 深合并进 target（就地修改 target）。
 *
 * target 非 plain object 时不做任何事（无处可并）。
 *
 * @param {object} target - 被修改的目标对象（如 mutateConfigFile 的 draft）
 * @param {unknown} patch - 要并入的补丁；非 plain object 时整体忽略
 */
export function deepMergeInto(target, patch) {
	if (!isPlainObject(target) || !isPlainObject(patch)) return;
	for (const [key, value] of Object.entries(patch)) {
		if (BLOCKED_KEYS.has(key)) continue;
		if (isPlainObject(value)) {
			if (!isPlainObject(target[key])) target[key] = {};
			deepMergeInto(target[key], value);
		}
		else {
			target[key] = value;
		}
	}
}
