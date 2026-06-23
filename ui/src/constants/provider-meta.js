/**
 * provider 元数据映射表（UI 端硬编码）
 *
 * displayName 现状：暂无消费点。模型设置页所有界面（API 密钥列表、撤销弹窗、
 * 添加 provider 选择器、主模型选择器）统一直接展示 OpenClaw 原生 provider id，
 * 排序也按 id——这张表只覆盖少数常用 provider，混用 id/品牌名既不一致又是维护负担。
 * 本字段保留、不删，待将来真要做品牌名展示时再启用（删除前请确认仍无引用）。
 *
 * 字段说明：
 * - displayName：品牌官方名，不进 i18n（品牌不翻译）；当前无消费点（见上）
 * - popular：是否在"添加 provider"流程的"常用"分组里（仍在用）
 * - dashboardUrl：去 provider 官网创建 key 的入口；缺省则不显示"去官网"链接（仍在用）
 *
 * 未在表中的 provider：fallback 为 { displayName: <id>, popular: false }，
 * 不显示"去官网"链接。完整 provider 清单由 `coclaw.providerAuth.catalog` 运行时拿。
 *
 * 设计文档：ui/docs/model-config.md § 8.1
 */
export const PROVIDER_META = {
	anthropic: {
		displayName: 'Anthropic Claude',
		popular: true,
		dashboardUrl: 'https://console.anthropic.com/settings/keys',
	},
	openai: {
		displayName: 'OpenAI',
		popular: true,
		dashboardUrl: 'https://platform.openai.com/api-keys',
	},
	google: {
		displayName: 'Google Gemini',
		popular: true,
		dashboardUrl: 'https://aistudio.google.com/apikey',
	},
	// groq 不进"常用"组：它当前不在 providerAuth.catalog 发现集（只走 model-catalog 推断路径），
	// 添加对话框里压根看不到它；保留 meta（displayName/dashboardUrl）备它将来真进 catalog 时正常展示。
	groq: {
		displayName: 'Groq',
		popular: false,
		dashboardUrl: 'https://console.groq.com/keys',
	},
	deepseek: {
		displayName: 'DeepSeek',
		popular: true,
		dashboardUrl: 'https://platform.deepseek.com/api_keys',
	},
	moonshot: {
		displayName: 'Moonshot (Kimi)',
		popular: true,
		dashboardUrl: 'https://platform.moonshot.cn/console/api-keys',
	},
	// 智谱：OpenClaw 真实 provider id 是 zai（非 zhipuai），key 必须与 catalog 一致才能匹配上、进"常用"组
	zai: {
		displayName: '智谱 AI (GLM)',
		popular: true,
		dashboardUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
	},
};

/**
 * 取一个 provider 的元数据；未知 provider 走 fallback
 *
 * @param {string} id - provider id
 * @returns {{ displayName: string, popular: boolean, dashboardUrl?: string }}
 */
export function getProviderMeta(id) {
	const hit = PROVIDER_META[id];
	if (hit) return hit;
	return { displayName: id, popular: false };
}
