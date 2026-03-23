/**
 * 将 OpenClaw gateway tools.catalog 返回的工具列表映射为用户友好的能力标签。
 * 供 Dashboard 展示 agent 能力概览。
 */

/**
 * @typedef {{ id: string, labelKey: string, icon: string, matchTools?: string[], matchSpecial?: string }} CapabilityDef
 */

/** @type {CapabilityDef[]} */
export const CAPABILITY_MAP = [
	{ id: 'web_search', labelKey: 'dashboard.cap.webSearch', icon: '🔍', matchTools: ['web_search', 'web_fetch'] },
	{ id: 'code_exec', labelKey: 'dashboard.cap.codeExec', icon: '💻', matchTools: ['exec', 'process'] },
	{ id: 'file_ops', labelKey: 'dashboard.cap.fileOps', icon: '📁', matchTools: ['read', 'write', 'edit', 'apply_patch'] },
	{ id: 'image_understanding', labelKey: 'dashboard.cap.imageUnderstanding', icon: '👁️', matchTools: ['image'] },
	{ id: 'image_generation', labelKey: 'dashboard.cap.imageGeneration', icon: '🎨', matchTools: ['image_generate'] },
	{ id: 'memory', labelKey: 'dashboard.cap.memory', icon: '📝', matchTools: ['memory_search', 'memory_get'] },
	{ id: 'team', labelKey: 'dashboard.cap.team', icon: '👥', matchTools: ['sessions_spawn', 'subagents'] },
	{ id: 'scheduler', labelKey: 'dashboard.cap.scheduler', icon: '⏰', matchTools: ['cron'] },
	{ id: 'browser', labelKey: 'dashboard.cap.browser', icon: '🌐', matchTools: ['browser'] },
	{ id: 'messaging', labelKey: 'dashboard.cap.messaging', icon: '💬', matchTools: ['message'] },
	{ id: 'tts', labelKey: 'dashboard.cap.tts', icon: '🗣️', matchSpecial: 'tts.enabled' },
];

/**
 * 将工具 ID 列表 + TTS 状态映射为能力标签数组
 * @param {string[]} toolIds - gateway 返回的工具 ID 列表
 * @param {boolean} [ttsEnabled=false] - TTS 是否启用
 * @returns {{ id: string, labelKey: string, icon: string }[]}
 */
export function mapToolsToCapabilities(toolIds, ttsEnabled = false) {
	const ids = Array.isArray(toolIds) ? toolIds : [];
	return CAPABILITY_MAP
		.filter(cap => {
			if (cap.matchTools) {
				return cap.matchTools.some(t => ids.includes(t));
			}
			if (cap.matchSpecial === 'tts.enabled') {
				return ttsEnabled === true;
			}
			return false;
		})
		.map(({ id, labelKey, icon }) => ({ id, labelKey, icon }));
}
