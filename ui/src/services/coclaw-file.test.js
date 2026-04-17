import { describe, test, expect, vi } from 'vitest';

vi.mock('./claw-connection-manager.js', () => ({
	useClawConnections: vi.fn(),
}));

vi.mock('./file-transfer.js', () => ({
	downloadFile: vi.fn(),
}));

import { buildCoclawUrl, parseCoclawUrl, isCoclawUrl, isCoclawScheme, extractCoclawPath, fetchCoclawFile, findCoclawMarkdownLinks } from './coclaw-file.js';
import { useClawConnections } from './claw-connection-manager.js';
import { downloadFile } from './file-transfer.js';

describe('buildCoclawUrl', () => {
	test('constructs URL with clawId, agentId, path', () => {
		const url = buildCoclawUrl('42', 'main', '.coclaw/chat-files/main/voice_123.webm');
		expect(url).toBe('coclaw-file://42:main/.coclaw/chat-files/main/voice_123.webm');
	});

	test('handles agentId with hyphens and underscores', () => {
		const url = buildCoclawUrl('1', 'my-agent_v2', 'file.wav');
		expect(url).toBe('coclaw-file://1:my-agent_v2/file.wav');
	});
});

describe('parseCoclawUrl', () => {
	test('parses valid URL', () => {
		const result = parseCoclawUrl('coclaw-file://42:main/.coclaw/chat-files/main/voice.webm');
		expect(result).toEqual({
			clawId: '42',
			agentId: 'main',
			path: '.coclaw/chat-files/main/voice.webm',
		});
	});

	test('parses URL with complex agentId', () => {
		const result = parseCoclawUrl('coclaw-file://7:agent-x_1/path/to/file.m4a');
		expect(result).toEqual({
			clawId: '7',
			agentId: 'agent-x_1',
			path: 'path/to/file.m4a',
		});
	});

	test('returns null for non-coclaw URL', () => {
		expect(parseCoclawUrl('https://example.com/file.wav')).toBeNull();
		expect(parseCoclawUrl('blob:https://localhost/abc')).toBeNull();
	});

	test('returns null for null/undefined/empty', () => {
		expect(parseCoclawUrl(null)).toBeNull();
		expect(parseCoclawUrl(undefined)).toBeNull();
		expect(parseCoclawUrl('')).toBeNull();
	});

	test('returns null when missing authority separator', () => {
		expect(parseCoclawUrl('coclaw-file://42/path')).toBeNull();
	});

	test('returns null when missing path', () => {
		expect(parseCoclawUrl('coclaw-file://42:main')).toBeNull();
		expect(parseCoclawUrl('coclaw-file://42:main/')).toBeNull();
	});

	test('returns null when clawId or agentId is empty', () => {
		expect(parseCoclawUrl('coclaw-file://:main/file')).toBeNull();
		expect(parseCoclawUrl('coclaw-file://42:/file')).toBeNull();
	});
});

describe('isCoclawUrl', () => {
	test('returns true for coclaw-file URL', () => {
		expect(isCoclawUrl('coclaw-file://1:main/file.webm')).toBe(true);
	});

	test('returns false for blob URL', () => {
		expect(isCoclawUrl('blob:https://localhost/abc-def')).toBe(false);
	});

	test('returns false for http URL', () => {
		expect(isCoclawUrl('https://example.com/audio.mp3')).toBe(false);
	});

	test('returns false for non-string', () => {
		expect(isCoclawUrl(null)).toBe(false);
		expect(isCoclawUrl(undefined)).toBe(false);
		expect(isCoclawUrl(42)).toBe(false);
	});
});

describe('buildCoclawUrl + parseCoclawUrl roundtrip', () => {
	test('parse(build(...)) returns original components', () => {
		const clawId = '99';
		const agentId = 'test-agent';
		const path = '.coclaw/topic-files/uuid-123/voice_456.webm';

		const url = buildCoclawUrl(clawId, agentId, path);
		const parsed = parseCoclawUrl(url);

		expect(parsed).toEqual({ clawId, agentId, path });
	});
});

describe('isCoclawScheme', () => {
	test('returns true for full URL', () => {
		expect(isCoclawScheme('coclaw-file://1:main/file.txt')).toBe(true);
	});

	test('returns true for short format', () => {
		expect(isCoclawScheme('coclaw-file:output/chart.png')).toBe(true);
	});

	test('returns false for other schemes', () => {
		expect(isCoclawScheme('https://example.com')).toBe(false);
		expect(isCoclawScheme('file:///path')).toBe(false);
	});

	test('returns false for non-string', () => {
		expect(isCoclawScheme(null)).toBe(false);
		expect(isCoclawScheme(42)).toBe(false);
	});
});

describe('extractCoclawPath', () => {
	test('extracts path from short format', () => {
		expect(extractCoclawPath('coclaw-file:output/chart.png')).toBe('output/chart.png');
	});

	test('extracts nested path', () => {
		expect(extractCoclawPath('coclaw-file:.coclaw/data/report.xlsx')).toBe('.coclaw/data/report.xlsx');
	});

	test('returns null for full URL format', () => {
		expect(extractCoclawPath('coclaw-file://1:main/file.txt')).toBeNull();
	});

	test('returns null for empty path', () => {
		expect(extractCoclawPath('coclaw-file:')).toBeNull();
	});

	test('decodes percent-encoded Chinese characters', () => {
		expect(extractCoclawPath('coclaw-file:.coclaw/1935.7%E3%80%8A%E4%B8%AD%E4%BA%9A%E3%80%8B.pdf'))
			.toBe('.coclaw/1935.7《中亚》.pdf');
	});

	test('decodes percent-encoded spaces', () => {
		expect(extractCoclawPath('coclaw-file:output/my%20file.txt')).toBe('output/my file.txt');
	});

	test('handles already decoded path unchanged', () => {
		expect(extractCoclawPath('coclaw-file:output/简单.txt')).toBe('output/简单.txt');
	});

	test('returns null for non-coclaw-file string', () => {
		expect(extractCoclawPath('https://example.com')).toBeNull();
	});

	test('returns null for null/undefined', () => {
		expect(extractCoclawPath(null)).toBeNull();
		expect(extractCoclawPath(undefined)).toBeNull();
	});
});

describe('findCoclawMarkdownLinks', () => {
	test('裸形式匹配普通链接', () => {
		const links = findCoclawMarkdownLinks('[报告](coclaw-file:output/report.pdf)');
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			isImg: false,
			label: '报告',
			url: 'coclaw-file:output/report.pdf',
			path: 'output/report.pdf',
		});
	});

	test('裸形式匹配图片语法', () => {
		const links = findCoclawMarkdownLinks('![趋势](coclaw-file:chart.png)');
		expect(links[0]).toMatchObject({ isImg: true, label: '趋势', path: 'chart.png' });
	});

	test('尖括号形式支持含半角括号的文件名', () => {
		const text = '[文件](<coclaw-file:盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx>)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx');
	});

	test('尖括号形式支持含空格的路径', () => {
		const links = findCoclawMarkdownLinks('[doc](<coclaw-file:带空格 和中文.pdf>)');
		expect(links[0].path).toBe('带空格 和中文.pdf');
	});

	// ── 裸形式的平衡括号容错（核心修复）──

	test('裸形式单层平衡括号', () => {
		const links = findCoclawMarkdownLinks('[x](coclaw-file:a(b).pdf)');
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('a(b).pdf');
	});

	test('裸形式多对平衡括号', () => {
		const links = findCoclawMarkdownLinks('[x](coclaw-file:a(1)_b_(2).pdf)');
		expect(links[0].path).toBe('a(1)_b_(2).pdf');
	});

	test('裸形式嵌套平衡括号', () => {
		const links = findCoclawMarkdownLinks('[x](coclaw-file:a(b(c)d).pdf)');
		expect(links[0].path).toBe('a(b(c)d).pdf');
	});

	test('裸形式深度嵌套括号', () => {
		const links = findCoclawMarkdownLinks('[x](coclaw-file:a(b(c(d))))');
		expect(links[0].path).toBe('a(b(c(d)))');
	});

	test('裸形式回归用户实际 bug 文件名', () => {
		const text = '[文件](coclaw-file:盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('盛成2026年3月会计报表(2020版)_已填充_副本_(7).xlsx');
	});

	// ── 跨行保护（关键安全性）──

	test('跨行保护：裸形式不平衡开括号不吞掉下一行的合法链接', () => {
		// 第一个链接 URL 里只有 (，没有对应 )，按旧版如果用贪婪就会吞掉下面好链接
		const text = '[坏](coclaw-file:bad(oops\n[好](coclaw-file:good.pdf)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('good.pdf');
	});

	test('跨行保护：未收尾的裸形式不影响下一行', () => {
		const text = '[a](coclaw-file:start\n[b](coclaw-file:b.pdf)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('b.pdf');
	});

	test('跨行保护：未收尾的尖括号形式不影响下一行', () => {
		const text = '[a](<coclaw-file:start\n[b](coclaw-file:b.pdf)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('b.pdf');
	});

	// ── 不平衡括号行为 ──

	test('裸形式单开括号：扫描到末尾仍无收尾 ) → 不匹配', () => {
		expect(findCoclawMarkdownLinks('[x](coclaw-file:a(b.pdf)')).toEqual([]);
	});

	test('裸形式单闭括号：在第一个 ) 收尾（路径被截短，符合语法预期）', () => {
		// 这种文件名（ASCII ) 但无配对 ( ）现实几乎不存在；此测试固化行为，避免静默回归
		const links = findCoclawMarkdownLinks('[x](coclaw-file:a)b.pdf)');
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('a');
	});

	// ── 终止字符 ──

	test('裸形式路径含空格终止', () => {
		expect(findCoclawMarkdownLinks('[x](coclaw-file:foo bar.pdf)')).toEqual([]);
	});

	test('裸形式路径含 Tab 终止', () => {
		expect(findCoclawMarkdownLinks('[x](coclaw-file:foo\tbar.pdf)')).toEqual([]);
	});

	test('裸形式路径含 < 或 > 终止', () => {
		expect(findCoclawMarkdownLinks('[x](coclaw-file:foo<bar.pdf)')).toEqual([]);
		expect(findCoclawMarkdownLinks('[x](coclaw-file:foo>bar.pdf)')).toEqual([]);
	});

	test('裸形式路径含换行（CR/LF）终止', () => {
		expect(findCoclawMarkdownLinks('[x](coclaw-file:a\nb.pdf)')).toEqual([]);
		expect(findCoclawMarkdownLinks('[x](coclaw-file:a\rb.pdf)')).toEqual([]);
	});

	test('尖括号形式内出现 < 或 > 时不匹配', () => {
		// CommonMark 规范：尖括号内不允许未转义的 < 或 >
		expect(findCoclawMarkdownLinks('[x](<coclaw-file:weird<a>.txt>)')).toEqual([]);
	});

	test('尖括号形式路径含换行（CR/LF）时不匹配', () => {
		expect(findCoclawMarkdownLinks('[x](<coclaw-file:a\nb.txt>)')).toEqual([]);
		expect(findCoclawMarkdownLinks('[x](<coclaw-file:a\rb.txt>)')).toEqual([]);
	});

	// ── 边界 ──

	test('空路径不匹配（裸形式）', () => {
		expect(findCoclawMarkdownLinks('[x](coclaw-file:)')).toEqual([]);
	});

	test('空路径不匹配（尖括号形式）', () => {
		expect(findCoclawMarkdownLinks('[x](<coclaw-file:>)')).toEqual([]);
	});

	test('空 label 允许', () => {
		const links = findCoclawMarkdownLinks('[](<coclaw-file:a.pdf>)');
		expect(links).toHaveLength(1);
		expect(links[0].label).toBe('');
		expect(links[0].path).toBe('a.pdf');
	});

	test('尖括号形式紧跟非 ) 时不匹配', () => {
		// <url> 后必须是 )
		expect(findCoclawMarkdownLinks('[x](<coclaw-file:a.pdf> extra)')).toEqual([]);
	});

	test('尖括号形式到字符串末尾仍未闭合时不匹配', () => {
		// EOF 前没找到 > → 失败，不产生半截匹配
		expect(findCoclawMarkdownLinks('[x](<coclaw-file:unterminated')).toEqual([]);
	});

	// ── 多链接与混合 ──

	test('混合形式按出现顺序返回', () => {
		const text = '![a](<coclaw-file:a.png>)\n\n[b](coclaw-file:b.pdf)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({ isImg: true, path: 'a.png' });
		expect(links[1]).toMatchObject({ isImg: false, path: 'b.pdf' });
	});

	test('同一行多个链接（其中含平衡括号）', () => {
		const text = '[a](coclaw-file:1.pdf) [b](coclaw-file:2(v2).pdf)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(2);
		expect(links[0].path).toBe('1.pdf');
		expect(links[1].path).toBe('2(v2).pdf');
	});

	test('返回 match 和 index 便于原位替换', () => {
		const text = '前缀 [x](<coclaw-file:a.txt>) 后缀';
		const links = findCoclawMarkdownLinks(text);
		expect(links[0].match).toBe('[x](<coclaw-file:a.txt>)');
		expect(text.slice(links[0].index, links[0].index + links[0].match.length)).toBe(links[0].match);
	});

	test('match 字段包含裸形式的完整括号', () => {
		const text = '前 [x](coclaw-file:a(1).pdf) 后';
		const links = findCoclawMarkdownLinks(text);
		expect(links[0].match).toBe('[x](coclaw-file:a(1).pdf)');
	});

	// ── 无匹配场景 ──

	test('空值/无 coclaw-file 时返回空数组', () => {
		expect(findCoclawMarkdownLinks(null)).toEqual([]);
		expect(findCoclawMarkdownLinks('')).toEqual([]);
		expect(findCoclawMarkdownLinks('纯文本 [x](https://example.com)')).toEqual([]);
	});

	test('非 coclaw-file scheme 不匹配', () => {
		expect(findCoclawMarkdownLinks('[x](file:/etc/passwd)')).toEqual([]);
		expect(findCoclawMarkdownLinks('[x](coclaw:foo.txt)')).toEqual([]);
	});

	// ── 稳定性 ──

	test('多次调用互不干扰（无 lastIndex 泄漏）', () => {
		const text = '[a](<coclaw-file:a.txt>)';
		expect(findCoclawMarkdownLinks(text)).toHaveLength(1);
		expect(findCoclawMarkdownLinks(text)).toHaveLength(1);
	});

	test('URL 内含嵌套 [...] 时不被当作新链接重复匹配', () => {
		// 罕见输入，固化行为：扫描器按平衡括号规则消费整段，
		// 嵌套的 (coclaw-file:x.pdf) 会被当作外层 URL 的一段字符
		const text = '[outer](coclaw-file:weird[inner](coclaw-file:x.pdf)nope)';
		const links = findCoclawMarkdownLinks(text);
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe('weird[inner](coclaw-file:x.pdf)nope');
	});
});

describe('fetchCoclawFile', () => {
	test('解析 URL 并通过 downloadFile 获取 blob', async () => {
		const fakeBlob = new Blob(['hello'], { type: 'text/plain' });
		const fakeBotConn = { id: '42' };
		useClawConnections.mockReturnValue({ get: vi.fn(() => fakeBotConn) });
		downloadFile.mockReturnValue({ promise: Promise.resolve({ blob: fakeBlob }) });

		const result = await fetchCoclawFile('coclaw-file://42:main/path/to/file.txt');

		expect(downloadFile).toHaveBeenCalledWith(fakeBotConn, 'main', 'path/to/file.txt');
		expect(result).toBe(fakeBlob);
	});

	test('URL 无效时抛出错误', async () => {
		await expect(fetchCoclawFile('https://invalid.com/file'))
			.rejects.toThrow('Invalid coclaw-file URL');
	});

	test('bot 连接不存在时抛出错误', async () => {
		useClawConnections.mockReturnValue({ get: vi.fn(() => undefined) });

		await expect(fetchCoclawFile('coclaw-file://99:main/file.txt'))
			.rejects.toThrow('Claw connection not found: 99');
	});
});
