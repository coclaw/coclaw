import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
	fileToBase64, formatFileSize, formatFileBlob,
	isImageByExt, chatFilesDir, topicFilesDir,
	buildAttachmentBlock, parseAttachmentBlock,
	validateCoclawPath, extractCoclawFileRefs,
	// saveBlobToFile / __nativeShareFile 在测试中通过 dynamic import 获取（需 vi.doMock）
} from './file-helper.js';

const origCreateObjectURL = URL.createObjectURL;
const origRevokeObjectURL = URL.revokeObjectURL;

describe('fileToBase64', () => {
	test('converts file to base64 string without data-url prefix', async () => {
		const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
		const result = await fileToBase64(file);
		// 'hello' in base64 is 'aGVsbG8='
		expect(result).toBe('aGVsbG8=');
	});

	test('converts image file to base64', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const file = new File([bytes], 'img.png', { type: 'image/png' });
		const result = await fileToBase64(file);
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
		// 不含 data-url 前缀
		expect(result).not.toContain('data:');
		expect(result).not.toContain(',');
	});
});

describe('formatFileSize', () => {
	test('returns "0 B" for zero or negative', () => {
		expect(formatFileSize(0)).toBe('0 B');
		expect(formatFileSize(-1)).toBe('0 B');
		expect(formatFileSize(null)).toBe('0 B');
	});

	test('returns bytes for < 1024', () => {
		expect(formatFileSize(512)).toBe('512 B');
	});

	test('returns KB for < 1MB', () => {
		expect(formatFileSize(2048)).toBe('2.0 KB');
	});

	test('returns MB for >= 1MB', () => {
		expect(formatFileSize(1024 * 1024 * 3.5)).toBe('3.5 MB');
	});

	test('returns GB for >= 1GB', () => {
		expect(formatFileSize(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
	});
});

describe('formatFileBlob', () => {
	beforeEach(() => {
		vi.stubGlobal('crypto', {
			randomUUID: vi.fn(() => 'test-uuid-1'),
		});
		URL.createObjectURL = vi.fn(() => 'blob:mock-url');
		URL.revokeObjectURL = vi.fn();
	});

	afterEach(() => {
		URL.createObjectURL = origCreateObjectURL;
		URL.revokeObjectURL = origRevokeObjectURL;
	});

	test('correctly identifies image files', () => {
		const file = new File(['data'], 'photo.png', { type: 'image/png' });
		const result = formatFileBlob(file);
		expect(result.isImg).toBe(true);
		expect(result.isVoice).toBe(false);
		expect(result.name).toBe('photo.png');
		expect(result.ext).toBe('png');
		expect(result.id).toBe('test-uuid-1');
		expect(result.url).toBeTruthy(); // objectURL created
	});

	test('correctly identifies non-image files', () => {
		const file = new File(['data'], 'readme.txt', { type: 'text/plain' });
		const result = formatFileBlob(file);
		expect(result.isImg).toBe(false);
		expect(result.url).toBeNull();
		expect(result.name).toBe('readme.txt');
		expect(result.ext).toBe('txt');
	});

	test('correctly identifies voice files', () => {
		const file = new File(['data'], 'voice.webm', { type: 'audio/webm' });
		const result = formatFileBlob(file);
		expect(result.isVoice).toBe(true);
		expect(result.isImg).toBe(false);
	});

	test('formats file size label', () => {
		const blob = new Blob(['x'.repeat(2048)], { type: 'text/plain' });
		blob.name = 'test.txt';
		// Blob 没有 name 属性，使用默认 'file'
		const result = formatFileBlob(blob);
		expect(result.label).toBe('2.0 KB');
	});

	test('handles file without extension', () => {
		const file = new File(['data'], 'Makefile', { type: 'application/octet-stream' });
		const result = formatFileBlob(file);
		expect(result.ext).toBe('');
		expect(result.name).toBe('Makefile');
	});
});

describe('isImageByExt', () => {
	test('recognizes common image extensions', () => {
		expect(isImageByExt('photo.png')).toBe(true);
		expect(isImageByExt('photo.jpg')).toBe(true);
		expect(isImageByExt('photo.jpeg')).toBe(true);
		expect(isImageByExt('photo.gif')).toBe(true);
		expect(isImageByExt('photo.webp')).toBe(true);
		expect(isImageByExt('photo.svg')).toBe(true);
		expect(isImageByExt('photo.bmp')).toBe(true);
	});

	test('case insensitive', () => {
		expect(isImageByExt('photo.PNG')).toBe(true);
		expect(isImageByExt('photo.Jpg')).toBe(true);
	});

	test('returns false for non-image extensions', () => {
		expect(isImageByExt('doc.pdf')).toBe(false);
		expect(isImageByExt('voice.webm')).toBe(false);
		expect(isImageByExt('app.js')).toBe(false);
	});

	test('returns false for no extension', () => {
		expect(isImageByExt('Makefile')).toBe(false);
	});

	test('handles paths with directories', () => {
		expect(isImageByExt('.coclaw/chat-files/main/2026-03/photo-a3f1.jpg')).toBe(true);
		expect(isImageByExt('.coclaw/chat-files/main/2026-03/report-b7e2.pdf')).toBe(false);
	});
});

describe('chatFilesDir', () => {
	test('extracts rest and escapes colons', () => {
		// 冻结时间以确定 YYYY-MM
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-15T10:00:00'));

		expect(chatFilesDir('agent:main:main')).toBe('.coclaw/chat-files/main/2026-03');
		expect(chatFilesDir('agent:main:telegram:direct:123'))
			.toBe('.coclaw/chat-files/telegram--direct--123/2026-03');

		vi.useRealTimers();
	});

	test('handles single segment rest', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-12-01T10:00:00'));
		expect(chatFilesDir('agent:main:main')).toBe('.coclaw/chat-files/main/2026-12');
		vi.useRealTimers();
	});
});

describe('topicFilesDir', () => {
	test('builds correct path', () => {
		const id = 'a1b2c3d4-5678-9abc-def0-123456789abc';
		expect(topicFilesDir(id)).toBe(`.coclaw/topic-files/${id}`);
	});
});

describe('buildAttachmentBlock', () => {
	test('builds basic table without Name column', () => {
		const files = [
			{ path: '.coclaw/chat-files/main/2026-03/photo-a3f1.jpg', name: 'photo.jpg', size: 204800 },
			{ path: '.coclaw/chat-files/main/2026-03/report-b7e2.pdf', name: 'report.pdf', size: 2202009 },
		];
		const result = buildAttachmentBlock(files);
		expect(result).toContain('## coclaw-attachments 🗂');
		expect(result).toContain('| Path | Size |');
		expect(result).toContain('| .coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200.0 KB |');
		expect(result).toContain('| .coclaw/chat-files/main/2026-03/report-b7e2.pdf | 2.1 MB |');
		expect(result).not.toContain('Name');
	});

	test('adds Name column on collision', () => {
		const files = [
			{ path: '.coclaw/chat-files/main/2026-03/photo-a3f1.jpg', name: 'photo.jpg', size: 204800 },
			{ path: '.coclaw/chat-files/main/2026-03/photo-c9d4.jpg', name: 'photo.jpg', size: 153600 },
		];
		const result = buildAttachmentBlock(files);
		expect(result).toContain('| Path | Size | Name |');
		// 碰撞文件都填入 name
		expect(result).toContain('| .coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200.0 KB | photo.jpg |');
		expect(result).toContain('| .coclaw/chat-files/main/2026-03/photo-c9d4.jpg | 150.0 KB | photo.jpg |');
	});

	test('mixed collision: only collided names filled', () => {
		const files = [
			{ path: 'a/photo-a3f1.jpg', name: 'photo.jpg', size: 100 },
			{ path: 'a/photo-c9d4.jpg', name: 'photo.jpg', size: 200 },
			{ path: 'a/report-b7e2.pdf', name: 'report.pdf', size: 300 },
		];
		const result = buildAttachmentBlock(files);
		expect(result).toContain('| Name |');
		// report.pdf 不碰撞，Name 列留空
		expect(result).toContain('| a/report-b7e2.pdf | 300 B |  |');
	});

	test('returns empty string for empty input', () => {
		expect(buildAttachmentBlock([])).toBe('');
		expect(buildAttachmentBlock(null)).toBe('');
	});
});

describe('parseAttachmentBlock', () => {
	test('parses basic table', () => {
		const text = '帮我分析\n\n## coclaw-attachments 🗂\n\n| Path | Size |\n|------|------|\n| .coclaw/f/photo.jpg | 200KB |';
		const { cleanText, attachments } = parseAttachmentBlock(text);
		expect(cleanText).toBe('帮我分析');
		expect(attachments).toHaveLength(1);
		expect(attachments[0].path).toBe('.coclaw/f/photo.jpg');
		expect(attachments[0].size).toBe('200KB');
		expect(attachments[0].name).toBe('');
	});

	test('parses table with Name column', () => {
		const text = '对比\n\n## coclaw-attachments 🗂\n\n| Path | Size | Name |\n|------|------|------|\n| a/p-a3.jpg | 200KB | |\n| a/p-c9.jpg | 150KB | photo.jpg |';
		const { cleanText, attachments } = parseAttachmentBlock(text);
		expect(cleanText).toBe('对比');
		expect(attachments).toHaveLength(2);
		expect(attachments[0].name).toBe('');
		expect(attachments[1].name).toBe('photo.jpg');
	});

	test('handles text without attachment block', () => {
		const text = '普通消息';
		const { cleanText, attachments } = parseAttachmentBlock(text);
		expect(cleanText).toBe('普通消息');
		expect(attachments).toHaveLength(0);
	});

	test('handles attachment-only message (no text)', () => {
		const text = '## coclaw-attachments 🗂\n\n| Path | Size |\n|------|------|\n| a/report.pdf | 2.1MB |';
		const { cleanText, attachments } = parseAttachmentBlock(text);
		expect(cleanText).toBe('');
		expect(attachments).toHaveLength(1);
		expect(attachments[0].path).toBe('a/report.pdf');
	});

	test('handles empty/null input', () => {
		expect(parseAttachmentBlock('')).toEqual({ cleanText: '', attachments: [] });
		expect(parseAttachmentBlock(null)).toEqual({ cleanText: '', attachments: [] });
	});

	test('multiple files', () => {
		const text = '看看\n\n## coclaw-attachments 🗂\n\n| Path | Size |\n|------|------|\n| a/p.jpg | 200KB |\n| a/r.pdf | 2MB |\n| a/v.webm | 120KB |';
		const { attachments } = parseAttachmentBlock(text);
		expect(attachments).toHaveLength(3);
	});
});

describe('validateCoclawPath', () => {
	test('accepts normal relative paths', () => {
		expect(validateCoclawPath('output/chart.png')).toBe(true);
		expect(validateCoclawPath('.coclaw/data/report.xlsx')).toBe(true);
		expect(validateCoclawPath('file.txt')).toBe(true);
	});

	test('rejects path traversal', () => {
		expect(validateCoclawPath('../etc/passwd')).toBe(false);
		expect(validateCoclawPath('output/../../../etc/passwd')).toBe(false);
		expect(validateCoclawPath('a/b/../c')).toBe(false);
	});

	test('rejects bare .. (no slash)', () => {
		expect(validateCoclawPath('..')).toBe(false);
	});

	test('rejects absolute paths', () => {
		expect(validateCoclawPath('/home/user/file.txt')).toBe(false);
		expect(validateCoclawPath('/etc/passwd')).toBe(false);
	});

	test('rejects backslash paths', () => {
		expect(validateCoclawPath('output\\file.txt')).toBe(false);
		expect(validateCoclawPath('..\\etc\\passwd')).toBe(false);
	});

	test('rejects empty/null', () => {
		expect(validateCoclawPath('')).toBe(false);
		expect(validateCoclawPath(null)).toBe(false);
		expect(validateCoclawPath(undefined)).toBe(false);
	});
});

describe('extractCoclawFileRefs', () => {
	test('extracts image references', () => {
		const text = '结果如下：\n\n![趋势图](coclaw-file:output/trend.png)\n\n分析完成。';
		const refs = extractCoclawFileRefs(text);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({
			path: 'output/trend.png',
			name: '趋势图',
			isImg: true,
			isVoice: false,
		});
	});

	test('extracts link references', () => {
		const text = '详见 [完整报告](coclaw-file:output/report.xlsx)。';
		const refs = extractCoclawFileRefs(text);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({
			path: 'output/report.xlsx',
			name: '完整报告',
			isImg: false,
			isVoice: false,
		});
	});

	test('extracts mixed references in order', () => {
		const text = '![图](coclaw-file:a.png)\n\n[报告](coclaw-file:b.pdf)\n\n![图2](coclaw-file:c.jpg)';
		const refs = extractCoclawFileRefs(text);
		expect(refs).toHaveLength(3);
		expect(refs[0].path).toBe('a.png');
		expect(refs[1].path).toBe('b.pdf');
		expect(refs[2].path).toBe('c.jpg');
	});

	test('deduplicates by path', () => {
		const text = '![图](coclaw-file:output/chart.png)\n\n再看一次 ![图](coclaw-file:output/chart.png)';
		const refs = extractCoclawFileRefs(text);
		expect(refs).toHaveLength(1);
	});

	test('uses filename as name when alt is empty', () => {
		const text = '![](coclaw-file:output/data.csv)';
		const refs = extractCoclawFileRefs(text);
		expect(refs[0].name).toBe('data.csv');
	});

	test('skips invalid paths (traversal)', () => {
		const text = '[hack](coclaw-file:../etc/passwd)';
		const refs = extractCoclawFileRefs(text);
		expect(refs).toHaveLength(0);
	});

	test('skips absolute paths', () => {
		const text = '[file](coclaw-file:/etc/passwd)';
		const refs = extractCoclawFileRefs(text);
		expect(refs).toHaveLength(0);
	});

	test('returns empty for null/empty text', () => {
		expect(extractCoclawFileRefs(null)).toEqual([]);
		expect(extractCoclawFileRefs('')).toEqual([]);
	});

	test('returns empty when no coclaw-file refs', () => {
		expect(extractCoclawFileRefs('普通文本 [link](https://example.com)')).toEqual([]);
	});

	test('identifies voice files', () => {
		const text = '[录音](coclaw-file:output/recording.webm)';
		const refs = extractCoclawFileRefs(text);
		expect(refs[0].isVoice).toBe(true);
	});
});

describe('saveBlobToFile', () => {
	let origCreate;

	beforeEach(() => {
		origCreate = URL.createObjectURL;
		URL.createObjectURL = vi.fn(() => 'blob:mock-url');
		URL.revokeObjectURL = vi.fn();
	});

	afterEach(() => {
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevokeObjectURL;
		vi.restoreAllMocks();
	});

	test('Web 环境：创建 <a download> 触发浏览器下载', async () => {
		// mock platform 为 web
		vi.doMock('./platform.js', () => ({ isCapacitorApp: false }));

		const mockA = { href: '', download: '', click: vi.fn() };
		const origCreateElement = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation((tag) =>
			tag === 'a' ? mockA : origCreateElement(tag),
		);
		vi.spyOn(document.body, 'appendChild').mockImplementation(() => {});
		vi.spyOn(document.body, 'removeChild').mockImplementation(() => {});

		const blob = new Blob(['hello'], { type: 'text/plain' });
		// 重新 import 使 doMock 生效
		const { saveBlobToFile: save } = await import('./file-helper.js');
		await save(blob, 'test.txt');

		expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
		expect(mockA.download).toBe('test.txt');
		expect(mockA.href).toBe('blob:mock-url');
		expect(mockA.click).toHaveBeenCalledOnce();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
	});

	test('Capacitor 环境：调用 __nativeShareFile', async () => {
		vi.doMock('./platform.js', () => ({ isCapacitorApp: true }));
		vi.doMock('@capacitor/filesystem', () => ({
			Filesystem: {
				writeFile: vi.fn().mockResolvedValue({ uri: 'file:///cache/test.txt' }),
				deleteFile: vi.fn().mockResolvedValue(),
				rmdir: vi.fn().mockResolvedValue(),
			},
			Directory: { Cache: 'CACHE' },
		}));
		vi.doMock('@capacitor/share', () => ({
			Share: { share: vi.fn().mockResolvedValue() },
		}));

		const blob = new Blob(['hello']);
		const { saveBlobToFile: save } = await import('./file-helper.js');
		await save(blob, 'test.txt');

		const { Filesystem } = await import('@capacitor/filesystem');
		const { Share } = await import('@capacitor/share');
		expect(Filesystem.writeFile).toHaveBeenCalledOnce();
		expect(Share.share).toHaveBeenCalledWith({ files: ['file:///cache/test.txt'] });
		expect(Filesystem.deleteFile).toHaveBeenCalledOnce();
	});
});

describe('__nativeShareFile', () => {
	let writeFileMock, deleteFileMock, rmdirMock, shareMock;

	beforeEach(() => {
		writeFileMock = vi.fn().mockResolvedValue({ uri: 'file:///cache/doc.pdf' });
		deleteFileMock = vi.fn().mockResolvedValue();
		rmdirMock = vi.fn().mockResolvedValue();
		shareMock = vi.fn().mockResolvedValue();

		vi.doMock('@capacitor/filesystem', () => ({
			Filesystem: { writeFile: writeFileMock, deleteFile: deleteFileMock, rmdir: rmdirMock },
			Directory: { Cache: 'CACHE' },
		}));
		vi.doMock('@capacitor/share', () => ({
			Share: { share: shareMock },
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('写入 Cache 目录（含 recursive）、调起分享、最后删除临时文件和子目录', async () => {
		const blob = new Blob(['pdf-data'], { type: 'application/pdf' });
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		await nativeShare(blob, 'doc.pdf');

		// writeFile 用 base64 写入 Cache 的唯一子目录，保留原始文件名
		expect(writeFileMock).toHaveBeenCalledOnce();
		const writeArgs = writeFileMock.mock.calls[0][0];
		expect(writeArgs.path).toMatch(/^coclaw_\d+\/doc\.pdf$/);
		expect(writeArgs.directory).toBe('CACHE');
		expect(writeArgs.recursive).toBe(true);
		expect(typeof writeArgs.data).toBe('string'); // base64

		// 用返回的 uri 调起分享
		expect(shareMock).toHaveBeenCalledWith({ files: ['file:///cache/doc.pdf'] });

		// 分享完成后删除临时文件和子目录
		expect(deleteFileMock).toHaveBeenCalledWith({
			path: writeArgs.path,
			directory: 'CACHE',
		});
		expect(rmdirMock).toHaveBeenCalledWith({
			path: writeArgs.path.substring(0, writeArgs.path.lastIndexOf('/')),
			directory: 'CACHE',
		});
	});

	test('用户取消分享面板时静默处理，不向上抛出', async () => {
		shareMock.mockRejectedValue(new Error('Share canceled'));

		const blob = new Blob(['data']);
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		// 不应抛出
		await expect(nativeShare(blob, 'cancel.txt')).resolves.toBeUndefined();

		// 仍应清理临时文件
		expect(deleteFileMock).toHaveBeenCalledOnce();
		expect(rmdirMock).toHaveBeenCalledOnce();
	});

	test('非取消的分享错误仍向上抛出，且清理临时文件', async () => {
		shareMock.mockRejectedValue(new Error('Share plugin unavailable'));

		const blob = new Blob(['data']);
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		await expect(nativeShare(blob, 'fail.txt')).rejects.toThrow('Share plugin unavailable');

		// 即使 share 失败，cleanup 仍应执行
		expect(deleteFileMock).toHaveBeenCalledOnce();
		expect(rmdirMock).toHaveBeenCalledOnce();
	});

	test('deleteFile 失败时输出警告但不抛出', async () => {
		deleteFileMock.mockRejectedValue(new Error('IO error'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const blob = new Blob(['data']);
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		await expect(nativeShare(blob, 'ok.txt')).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			'[saveBlobToFile] cache cleanup failed:',
			expect.any(Error),
		);
		warnSpy.mockRestore();
	});

	test('rmdir 失败时输出警告但不抛出', async () => {
		rmdirMock.mockRejectedValue(new Error('dir not empty'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const blob = new Blob(['data']);
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		await expect(nativeShare(blob, 'ok.txt')).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			'[saveBlobToFile] cache dir cleanup failed:',
			expect.any(Error),
		);
		warnSpy.mockRestore();
	});

	test('writeFile 失败时直接抛出（无需清理）', async () => {
		writeFileMock.mockRejectedValue(new Error('disk full'));

		const blob = new Blob(['data']);
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		await expect(nativeShare(blob, 'full.txt')).rejects.toThrow('disk full');

		// writeFile 在 try 之前失败，不会触发 cleanup
		expect(shareMock).not.toHaveBeenCalled();
		expect(deleteFileMock).not.toHaveBeenCalled();
	});

	test('base64 数据正确转换', async () => {
		const blob = new Blob(['hello'], { type: 'text/plain' });
		const { __nativeShareFile: nativeShare } = await import('./file-helper.js');

		await nativeShare(blob, 'hello.txt');

		const writeArgs = writeFileMock.mock.calls[0][0];
		// 'hello' → base64 = 'aGVsbG8='
		expect(writeArgs.data).toBe('aGVsbG8=');
	});
});
