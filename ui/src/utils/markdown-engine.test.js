import { describe, test, expect } from 'vitest';
import { renderMarkdown, reviseMdText } from './markdown-engine.js';

describe('reviseMdText', () => {
	test('空值返回空字符串', () => {
		expect(reviseMdText('')).toBe('');
		expect(reviseMdText(null)).toBe('');
		expect(reviseMdText(undefined)).toBe('');
	});

	test('转换 LaTeX block: \\[ \\] → $$ $$', () => {
		const input = '公式 \\[ x^2 + y^2 \\] 结束';
		const result = reviseMdText(input);
		expect(result).toContain('$$');
		expect(result).not.toContain('\\[');
		expect(result).not.toContain('\\]');
	});

	test('转换 LaTeX inline: \\( \\) → $ $', () => {
		const input = '行内 \\( a+b \\) 公式';
		const result = reviseMdText(input);
		expect(result).toContain('$');
		expect(result).not.toContain('\\(');
		expect(result).not.toContain('\\)');
	});

	test('不含 LaTeX 的文本不变', () => {
		expect(reviseMdText('Hello world')).toBe('Hello world');
	});
});

describe('renderMarkdown', () => {
	test('空文本返回空字符串', () => {
		expect(renderMarkdown('')).toBe('');
	});

	test('渲染标题', () => {
		const html = renderMarkdown('# Hello');
		expect(html).toContain('<h1>');
		expect(html).toContain('Hello');
	});

	test('渲染段落', () => {
		const html = renderMarkdown('Hello world');
		expect(html).toContain('<p>');
		expect(html).toContain('Hello world');
	});

	test('渲染代码块带语法高亮', () => {
		const html = renderMarkdown('```js\nconst x = 1;\n```');
		expect(html).toContain('hljs-code-container');
		expect(html).toContain('language-js');
	});

	test('未知语言回退为 text', () => {
		const html = renderMarkdown('```unknownlang\nhello\n```');
		expect(html).toContain('language-text');
	});

	test('链接添加 target=_blank', () => {
		const html = renderMarkdown('[link](https://example.com)');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener"');
	});

	test('渲染列表', () => {
		const html = renderMarkdown('- item1\n- item2');
		expect(html).toContain('<ul>');
		expect(html).toContain('<li>');
	});

	test('渲染表格', () => {
		const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<table>');
		expect(html).toContain('<th>');
		expect(html).toContain('<td>');
	});
});
