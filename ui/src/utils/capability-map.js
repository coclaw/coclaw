/**
 * 将 OpenClaw gateway tools.catalog 返回的工具列表映射为用户友好的能力标签。
 * 供 Dashboard 展示 agent 能力概览。
 */

/**
 * @typedef {{ id: string, label: string, icon: string, matchTools?: string[], matchSpecial?: string }} CapabilityDef
 */

/** @type {CapabilityDef[]} */
export const CAPABILITY_MAP = [
	{ id: 'web_search', label: '联网搜索', icon: '🔍', matchTools: ['web_search', 'web_fetch'] },
	{ id: 'code_exec', label: '执行代码', icon: '💻', matchTools: ['exec', 'process'] },
	{ id: 'file_ops', label: '文件读写', icon: '📁', matchTools: ['read', 'write', 'edit', 'apply_patch'] },
	{ id: 'image_understanding', label: '图片理解', icon: '👁️', matchTools: ['image'] },
	{ id: 'image_generation', label: '图片生成', icon: '🎨', matchTools: ['image_generate'] },
	{ id: 'memory', label: '长期记忆', icon: '📝', matchTools: ['memory_search', 'memory_get'] },
	{ id: 'team', label: '团队协作', icon: '👥', matchTools: ['sessions_spawn', 'subagents'] },
	{ id: 'scheduler', label: '定时任务', icon: '⏰', matchTools: ['cron'] },
	{ id: 'browser', label: '浏览器控制', icon: '🌐', matchTools: ['browser'] },
	{ id: 'messaging', label: '消息通知', icon: '💬', matchTools: ['message'] },
	{ id: 'tts', label: '语音对话', icon: '🗣️', matchSpecial: 'tts.enabled' },
];

/**
 * 将工具 ID 列表 + TTS 状态映射为能力标签数组
 * @param {string[]} toolIds - gateway 返回的工具 ID 列表
 * @param {boolean} [ttsEnabled=false] - TTS 是否启用
 * @returns {{ id: string, label: string, icon: string }[]}
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
		.map(({ id, label, icon }) => ({ id, label, icon }));
}
