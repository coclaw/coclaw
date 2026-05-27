/**
 * provider 元数据映射表（UI 端硬编码）
 *
 * 字段说明：
 * - displayName：品牌官方名，不进 i18n（品牌不翻译）
 * - popular：是否在"添加 provider"流程的"常用"分组里
 * - dashboardUrl：去 provider 官网创建 key 的入口；缺省则不显示"去官网"链接
 *
 * 未在表中的 provider：fallback 为 { displayName: <id>, popular: false }，
 * 不显示"去官网"链接。完整 provider 清单由 `models.list view:"all"` 运行时拿。
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
	groq: {
		displayName: 'Groq',
		popular: true,
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
	zhipuai: {
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

/**
 * CoClaw 管理的扫码(oauth)登录服务商白名单。
 *
 * oauth 凭据默认不可在 UI 撤销（read-only）——只有“CoClaw 自己能发起扫码登录”的
 * 服务商才允许撤销：撤销后用户能在 CoClaw 内重新登录回来，构成往返闭环。
 * 像 openai-codex 这类 OpenClaw 自带、须在 CLI 外部配置的 oauth 服务商不在此列，
 * 否则就成了“只能登出不能再登”的单向陷阱。
 *
 * 耦合：此处 id 必须与插件端 PORTAL_PROVIDER_ID（'minimax-portal'）保持一致，
 * 插件改名时本白名单要同步跟改。
 *
 * @type {Set<string>}
 */
export const COCLAW_OAUTH_PROVIDERS = new Set(['minimax-portal']);
