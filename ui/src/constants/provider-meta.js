/**
 * provider 元数据映射表（UI 端硬编码）
 *
 * name（原 displayName）现已有消费点：添加 provider 弹窗、API 密钥列表、撤销确认、
 * Dashboard 机型标签都经 getProviderName 走它显示品牌名（provider id 仍是唯一真值，
 * 仅展示文本换名）。Tier-2 的 provider/model 复合标识处（主模型行 / claw 卡片 / 选模型器分组
 * 标题 + 搜索 + 排序）现也经 getProviderName 显示品牌名；id 仍是唯一真值，未覆盖的变体优雅回退裸 id。
 *
 * 字段说明：
 * - name：品牌官方名，不进 i18n（品牌不翻译）；经 getProviderName 消费
 * - popular：是否在"添加 provider"流程的"常用"分组里
 * - dashboardUrl：去 provider 官网创建 key 的入口；缺省则不显示"去官网"链接
 *
 * 未在表中的 provider：fallback 为 { name: <id>, popular: false }，
 * 不显示"去官网"链接。完整 provider 清单由 `coclaw.providerAuth.catalog` 运行时拿。
 *
 * 设计文档：ui/docs/model-config.md § 8.1
 */
export const PROVIDER_META = {
	anthropic: {
		name: 'Anthropic Claude',
		popular: false,
		dashboardUrl: 'https://console.anthropic.com/settings/keys',
	},
	openai: {
		name: 'OpenAI',
		popular: true,
		dashboardUrl: 'https://platform.openai.com/api-keys',
	},
	google: {
		name: 'Google Gemini',
		popular: false,
		dashboardUrl: 'https://aistudio.google.com/apikey',
	},
	// groq 不进"常用"组：它当前不在 providerAuth.catalog 发现集（只走 model-catalog 推断路径），
	// 添加对话框里压根看不到它；保留 meta（name/dashboardUrl）备它将来真进 catalog 时正常展示。
	groq: {
		name: 'Groq',
		popular: false,
		dashboardUrl: 'https://console.groq.com/keys',
	},
	deepseek: {
		name: 'DeepSeek',
		popular: true,
		dashboardUrl: 'https://platform.deepseek.com/api_keys',
	},
	moonshot: {
		name: 'Moonshot (Kimi)',
		popular: true,
		dashboardUrl: 'https://platform.moonshot.cn/console/api-keys',
	},
	// 智谱：OpenClaw 真实 provider id 是 zai（非 zhipuai），key 必须与 catalog 一致才能匹配上、进"常用"组
	zai: {
		name: 'ZhipuAI (GLM)',
		popular: true,
		dashboardUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
	},
	// 以下国内厂商进"常用"组：dashboardUrl 暂缺（不显示"去官网"链接），name 经 getProviderName 显示品牌名（见文件头）
	minimax: {
		name: 'MiniMax',
		popular: true,
	},
	'minimax-portal': {
		name: 'MiniMax (Portal)',
		popular: true,
	},
	qwen: {
		name: 'Qwen',
		popular: true,
	},
	volcengine: {
		name: 'Volcengine',
		popular: true,
	},
	openrouter: {
		name: 'OpenRouter',
		popular: true,
	},
	// 以下两条无 dashboardUrl、不进"常用"组：主要为 Dashboard 机型标签的 provider 名提供品牌名
	// （getProviderName 是共享 helper，故这两个 id 在任何展示点都会取到品牌名）。
	// 从原 model-tags.js 的 PROVIDER_NAMES 并入，避免标签退化为裸 id。
	meta: {
		name: 'Meta',
		popular: false,
	},
	mistral: {
		name: 'Mistral',
		popular: false,
	},
};

/**
 * "常用"分组的**显示顺序**来源。成员资格由 PROVIDER_META 的 popular:true 决定，本数组只定顺序，
 * 两者必须一致（由 provider-meta.test.js 的集合相等断言锁住，防漂移）。AddProviderDialog 的
 * popularList 按本数组的 index 排序（不在数组内的 popular 项兜底排末尾，与集合一致时不会发生）。
 *
 * @type {string[]}
 */
export const POPULAR_ORDER = [
	'deepseek',
	'zai',
	'minimax',
	'minimax-portal',
	'moonshot',
	'qwen',
	'volcengine',
	'openai',
	'openrouter',
];

/**
 * 取一个 provider 的元数据；未知 provider 走 fallback
 *
 * @param {string} id - provider id
 * @returns {{ name: string, popular: boolean, dashboardUrl?: string }}
 */
export function getProviderMeta(id) {
	const hit = PROVIDER_META[id];
	if (hit) return hit;
	return { name: id, popular: false };
}

/**
 * 取一个 provider 的友好品牌名；未知 provider 回退为 id 本身。
 * 纯显示用——provider id 仍是唯一真值，仅展示文本经此换名。
 *
 * @param {string} id - provider id
 * @returns {string}
 */
export function getProviderName(id) {
	return PROVIDER_META[id]?.name || id;
}
