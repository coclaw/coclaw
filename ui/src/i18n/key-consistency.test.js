// 防止任一语言遗漏 i18n key 让用户看到裸 key 字符串（如 "layout.addEntry" 显示在按钮上）。
// 任何新加的 key 必须在所有 locale 文件里同时出现，否则该 locale 的用户会看到 key 名而非翻译。
import { describe, expect, test } from 'vitest';

import { deMessages } from './locales/de.js';
import { enMessages } from './locales/en.js';
import { esMessages } from './locales/es.js';
import { frMessages } from './locales/fr.js';
import { hiMessages } from './locales/hi.js';
import { jaMessages } from './locales/ja.js';
import { koMessages } from './locales/ko.js';
import { ptMessages } from './locales/pt.js';
import { ruMessages } from './locales/ru.js';
import { viMessages } from './locales/vi.js';
import { zhCNMessages } from './locales/zh-CN.js';
import { zhTWMessages } from './locales/zh-TW.js';

/** 收集对象所有 leaf key 的扁平路径集合（如 "layout.addEntry"） */
function collectLeafKeys(obj, prefix = '') {
	const keys = new Set();
	for (const [k, v] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			for (const sub of collectLeafKeys(v, path)) keys.add(sub);
		}
		else {
			keys.add(path);
		}
	}
	return keys;
}

const locales = {
	en: enMessages,
	'zh-CN': zhCNMessages,
	'zh-TW': zhTWMessages,
	ja: jaMessages,
	ko: koMessages,
	fr: frMessages,
	de: deMessages,
	es: esMessages,
	pt: ptMessages,
	ru: ruMessages,
	vi: viMessages,
	hi: hiMessages,
};

describe('i18n key consistency', () => {
	const baseKeys = collectLeafKeys(locales.en);

	for (const [name, msgs] of Object.entries(locales)) {
		if (name === 'en') continue;
		test(`locale "${name}" 的 key 集合与 en 完全一致（既无遗漏也无多余）`, () => {
			const localeKeys = collectLeafKeys(msgs);
			const missing = [...baseKeys].filter((k) => !localeKeys.has(k));
			const extra = [...localeKeys].filter((k) => !baseKeys.has(k));
			expect({ locale: name, missing, extra }).toEqual({ locale: name, missing: [], extra: [] });
		});
	}
});
