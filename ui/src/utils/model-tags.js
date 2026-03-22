/**
 * 根据模型信息生成用于 Dashboard 展示的标签列表。
 */

const PROVIDER_NAMES = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	google: 'Google',
	meta: 'Meta',
	mistral: 'Mistral',
	deepseek: 'DeepSeek',
};

/**
 * @typedef {{ label: string, icon?: string, type: string }} ModelTag
 */

/**
 * 根据 model 对象生成展示标签
 * @param {{ id?: string, name?: string, provider?: string, contextWindow?: number, reasoning?: boolean, input?: string[] }} model
 * @returns {ModelTag[]}
 */
export function generateModelTags(model) {
	if (!model) return [];
	const tags = [];

	// 模型名称（始终展示）
	if (model.name) tags.push({ label: model.name, type: 'name' });

	// provider
	if (model.provider) {
		const name = PROVIDER_NAMES[model.provider] || model.provider;
		tags.push({ label: `由 ${name} 提供`, icon: '🏢', type: 'provider' });
	}

	// 推理
	if (model.reasoning) tags.push({ label: '深度推理', icon: '🧠', type: 'feature' });

	// 视觉
	if (model.input?.includes('image')) tags.push({ label: '支持视觉', icon: '📸', type: 'feature' });

	// 文档
	if (model.input?.includes('document')) tags.push({ label: '文档理解', icon: '📄', type: 'feature' });

	// 上下文窗口
	if (model.contextWindow >= 200000) tags.push({ label: '200K+ 上下文', icon: '📚', type: 'context' });
	else if (model.contextWindow >= 100000) tags.push({ label: '100K 上下文', icon: '📖', type: 'context' });
	else if (model.contextWindow >= 32000) tags.push({ label: '32K 上下文', icon: '📃', type: 'context' });

	return tags;
}
