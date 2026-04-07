import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import MarkdownItKatex from '@iktakahiro/markdown-it-katex';
import MarkdownItLinkAttributes from 'markdown-it-link-attributes';

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
 * 将 markdown 中的 coclaw-file 图片语法转为链接语法。
 * ![alt](coclaw-file:path) → [🖼 alt](coclaw-file:path)
 * Phase 2 实现内联图片渲染后，此预处理将不再需要。
 * @param {string} text
 * @returns {string}
 */
export function replaceCoclawFileImages(text) {
	if (!text || !text.includes('coclaw-file:')) return text;
	return text.replace(/!\[([^\]]*)\]\((coclaw-file:[^)]+)\)/g, (_, alt, url) => {
		const label = alt || url.slice('coclaw-file:'.length).split('/').pop();
		return `[\u{1F5BC}\u00A0${label}](${url})`;
	});
}

/**
 * 渲染 markdown 文本为 HTML
 * @param {string} text - markdown 源文本
 * @returns {string}
 */
export function renderMarkdown(text) {
	return md.render(text || '');
}
