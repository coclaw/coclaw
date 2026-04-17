import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import MarkdownItKatex from '@iktakahiro/markdown-it-katex';
import MarkdownItLinkAttributes from 'markdown-it-link-attributes';
import { findCoclawMarkdownLinks } from '../services/coclaw-file.js';

// markdown-it 全局单例
const md = createMarkdownIt();

function createMarkdownIt() {
	const inst = new MarkdownIt({
		breaks: true,
		highlight(code, lang) {
			const isKnown = lang && hljs.getLanguage(lang);
			const language = isKnown ? lang : 'text';

			// 显示标题：未知语言显示 data-i18n-text（由组件替换为翻译文本）
			let title = lang || '';
			if (!isKnown) {
				title = `<span data-i18n-text></span>`;
			} else if (lang === 'text') {
				title = `<span data-i18n-text></span>`;
			}

			const isPureText = language === 'markdown' || language === 'text';
			const fontReset = isPureText ? ' reset-font-family' : '';

			const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;

			return `<pre class="hljs-code-container${fontReset}">` +
				`<div class="hljs-code-header">` +
					`<span>${title}</span>` +
					`<button class="hljs-copy-button" data-copied="false" data-i18n-copy data-i18n-copied></button>` +
				`</div>` +
				`<code class="hljs language-${language}${fontReset}">` +
					`${highlighted}` +
				`</code>` +
			`</pre>`;
		},
	});

	inst.use(MarkdownItKatex, { strict: false });

	inst.use(MarkdownItLinkAttributes, {
		attrs: {
			target: '_blank',
			rel: 'noopener',
		},
	});

	return inst;
}

/**
 * 修订 AI 生成的 markdown 文本中的 LaTeX 语法
 * @param {string} text - 原始文本
 * @returns {string}
 */
export function reviseMdText(text) {
	if (!text) return '';
	return text
		// LaTeX Block: \[ \] → $$ $$
		.replaceAll(/\\\[\s*|\s*\\\]/g, '$$$$')
		// LaTeX Inline: \( \) → $ $
		.replaceAll(/\\\(\s*|\s*\\\)/g, '$$');
}

/**
 * 预处理 markdown 中的 coclaw-file 链接，确保 markdown-it 能正确解析。
 * - 图片语法转链接：![alt](coclaw-file:path) → [🖼 alt](<coclaw-file:path>)
 * - 普通链接统一包尖括号：[text](coclaw-file:path) → [text](<coclaw-file:path>)
 * - 已是尖括号形式的链接也会被命中（输出保持尖括号形式，等价幂等）
 *
 * 尖括号包裹 URL 是 CommonMark 标准语法，允许 URL 中含空格、中文、半角括号等，
 * 解决 markdown-it 对含特殊字符路径解析截断的问题。
 * @param {string} text
 * @returns {string}
 */
export function preprocessCoclawFileLinks(text) {
	if (!text || !text.includes('coclaw-file:')) return text;
	const links = findCoclawMarkdownLinks(text);
	if (!links.length) return text;
	// 逆序替换，避免 index 漂移
	let result = text;
	for (let i = links.length - 1; i >= 0; i--) {
		const { isImg, label, url, path, match, index } = links[i];
		const displayLabel = isImg ? (label || path.split('/').pop()) : label;
		const prefix = isImg ? '\u{1F5BC}\u00A0' : '';
		const replacement = `[${prefix}${displayLabel}](<${url}>)`;
		result = result.slice(0, index) + replacement + result.slice(index + match.length);
	}
	return result;
}

/**
 * 渲染 markdown 文本为 HTML
 * @param {string} text - markdown 源文本
 * @returns {string}
 */
export function renderMarkdown(text) {
	return md.render(text || '');
}
