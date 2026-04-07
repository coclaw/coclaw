import { describe, test, expect } from 'vitest';
import { renderMarkdown, reviseMdText, replaceCoclawFileImages } from './markdown-engine.js';

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

describe('replaceCoclawFileImages', () => {
	test('将 coclaw-file 图片语法转为链接语法', () => {
		const input = '![趋势图](coclaw-file:output/trend.png)';
		const result = replaceCoclawFileImages(input);
		expect(result).toContain('[🖼\u00A0趋势图](coclaw-file:output/trend.png)');
		expect(result).not.toContain('![');
	});

	test('alt 为空时用文件名', () => {
		const input = '![](coclaw-file:output/chart.png)';
		const result = replaceCoclawFileImages(input);
		expect(result).toContain('[🖼\u00A0chart.png](coclaw-file:output/chart.png)');
	});

	test('不影响普通图片语法', () => {
		const input = '![alt](https://example.com/img.png)';
		const result = replaceCoclawFileImages(input);
		expect(result).toBe(input);
	});

	test('不影响 coclaw-file 链接语法', () => {
		const input = '[报告](coclaw-file:output/report.pdf)';
		const result = replaceCoclawFileImages(input);
		expect(result).toBe(input);
	});

	test('处理多个图片', () => {
		const input = '![a](coclaw-file:a.png)\n\n![b](coclaw-file:b.jpg)';
		const result = replaceCoclawFileImages(input);
		expect(result).toContain('[🖼\u00A0a](coclaw-file:a.png)');
		expect(result).toContain('[🖼\u00A0b](coclaw-file:b.jpg)');
		expect(result).not.toContain('![');
	});

	test('空值或无 coclaw-file 时原样返回', () => {
		expect(replaceCoclawFileImages(null)).toBeNull();
		expect(replaceCoclawFileImages('')).toBe('');
		expect(replaceCoclawFileImages('普通文本')).toBe('普通文本');
	});
});
