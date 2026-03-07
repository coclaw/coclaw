import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { fileToBase64, formatFileSize, formatFileBlob } from './file-helper.js';

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
