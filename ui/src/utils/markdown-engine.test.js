import { describe, test, expect } from 'vitest';
import { renderMarkdown, reviseMdText, preprocessCoclawFileLinks } from './markdown-engine.js';

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

describe('preprocessCoclawFileLinks', () => {
	test('图片语法转为带尖括号的链接语法', () => {
		const input = '![趋势图](coclaw-file:output/trend.png)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[🖼\u00A0趋势图](<coclaw-file:output/trend.png>)');
	});

	test('alt 为空时用文件名', () => {
		const input = '![](coclaw-file:output/chart.png)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[🖼\u00A0chart.png](<coclaw-file:output/chart.png>)');
	});

	test('普通链接加尖括号', () => {
		const input = '[报告](coclaw-file:output/report.pdf)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[报告](<coclaw-file:output/report.pdf>)');
	});

	test('含空格和中文字符的路径正确处理', () => {
		const input = '[文档](coclaw-file:.coclaw/chat-files/main/2026-04/1935.7《中亚事务》-056e.pdf)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[文档](<coclaw-file:.coclaw/chat-files/main/2026-04/1935.7《中亚事务》-056e.pdf>)');
	});

	test('不影响普通图片语法', () => {
		const input = '![alt](https://example.com/img.png)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe(input);
	});

	test('不影响普通链接语法', () => {
		const input = '[link](https://example.com)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe(input);
	});

	test('处理多个混合链接', () => {
		const input = '![a](coclaw-file:a.png)\n\n[b](coclaw-file:b.pdf)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toContain('[🖼\u00A0a](<coclaw-file:a.png>)');
		expect(result).toContain('[b](<coclaw-file:b.pdf>)');
		expect(result).not.toContain('![');
	});

	test('空值或无 coclaw-file 时原样返回', () => {
		expect(preprocessCoclawFileLinks(null)).toBeNull();
		expect(preprocessCoclawFileLinks('')).toBe('');
		expect(preprocessCoclawFileLinks('普通文本')).toBe('普通文本');
	});

	test('尖括号形式含半角括号的文件名正确保留', () => {
		const input = '[文件](<coclaw-file:盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx>)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[文件](<coclaw-file:盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx>)');
	});

	test('尖括号形式的图片语法转换且保留 URL', () => {
		const input = '![图](<coclaw-file:a b(1).png>)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[🖼\u00A0图](<coclaw-file:a b(1).png>)');
	});

	test('裸形式含平衡括号容错：转换为尖括号形式后保留完整括号', () => {
		const input = '[文件](coclaw-file:盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[文件](<coclaw-file:盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx>)');
	});

	test('裸形式图片含括号：转换为链接形式并正确包尖括号', () => {
		const input = '![预览](coclaw-file:chart(v2).png)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toBe('[🖼\u00A0预览](<coclaw-file:chart(v2).png>)');
	});

	test('裸形式不平衡开括号不影响后续链接', () => {
		// 关键安全性：一条坏链接不应吞掉后面的好链接
		const input = '[坏](coclaw-file:bad(oops\n[好](coclaw-file:good.pdf)';
		const result = preprocessCoclawFileLinks(input);
		expect(result).toContain('[好](<coclaw-file:good.pdf>)');
		expect(result).toContain('[坏](coclaw-file:bad(oops'); // 未转换的原文保留
	});

	test('多次调用结果一致（幂等）', () => {
		const input = '[x](<coclaw-file:a.txt>) 和 ![y](coclaw-file:y(1).png)';
		const once = preprocessCoclawFileLinks(input);
		const twice = preprocessCoclawFileLinks(once);
		expect(twice).toBe(once);
	});

	test('集成：preprocess + renderMarkdown 对含括号裸形式生成完整 href', () => {
		// 端到端：agent 原文 → 预处理 → markdown-it 渲染，href 必须保留完整括号路径
		const input = '[文件](coclaw-file:盛成(2020版)_(7).xlsx)';
		const html = renderMarkdown(preprocessCoclawFileLinks(input));
		// markdown-it 对非 ASCII 会 percent-encode，但括号保持原样
		expect(html).toMatch(/href="coclaw-file:[^"]*\(2020%E7%89%88\)_\(7\)\.xlsx"/);
	});
});
