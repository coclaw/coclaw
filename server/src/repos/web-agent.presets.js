// 系统预置 Web Agent 清单
// 修改后重启 server，syncPresets 会自动同步 DB（双向：清单内 upsert，清单外删除）
export const PRESETS = [
	{ slug: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',   sort: 1 },
	{ slug: 'doubao',   name: '豆包',     url: 'https://www.doubao.com/chat/',  sort: 2 },
	{ slug: 'qwen',     name: '千问',     url: 'https://chat.qwen.ai/',         sort: 3 },
	{ slug: 'kimi',     name: 'Kimi',     url: 'https://kimi.com/',             sort: 4 },
	{ slug: 'yuanbao',  name: '元宝',     url: 'https://yuanbao.tencent.com/',  sort: 5 },
];

// 校验常量本身的合法性。重复 slug / 空字段必须 fail-fast
export function validatePresets(presets) {
	const seen = new Set();
	for (const p of presets) {
		if (!p.slug || !p.name || !p.url) {
			throw new Error(`invalid preset: missing slug/name/url for ${JSON.stringify(p)}`);
		}
		if (seen.has(p.slug)) {
			throw new Error(`duplicate preset slug: ${p.slug}`);
		}
		seen.add(p.slug);
	}
}
