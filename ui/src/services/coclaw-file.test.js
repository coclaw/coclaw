import { describe, test, expect, vi } from 'vitest';

vi.mock('./claw-connection-manager.js', () => ({
	useClawConnections: vi.fn(),
}));

vi.mock('./file-transfer.js', () => ({
	downloadFile: vi.fn(),
}));

import { buildCoclawUrl, parseCoclawUrl, isCoclawUrl, fetchCoclawFile } from './coclaw-file.js';
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
