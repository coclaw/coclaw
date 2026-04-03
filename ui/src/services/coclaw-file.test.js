import { describe, test, expect } from 'vitest';
import { buildCoclawUrl, parseCoclawUrl, isCoclawUrl } from './coclaw-file.js';

describe('buildCoclawUrl', () => {
	test('constructs URL with botId, agentId, path', () => {
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
			botId: '42',
			agentId: 'main',
			path: '.coclaw/chat-files/main/voice.webm',
		});
	});

	test('parses URL with complex agentId', () => {
		const result = parseCoclawUrl('coclaw-file://7:agent-x_1/path/to/file.m4a');
		expect(result).toEqual({
			botId: '7',
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

	test('returns null when botId or agentId is empty', () => {
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
		const botId = '99';
		const agentId = 'test-agent';
		const path = '.coclaw/topic-files/uuid-123/voice_456.webm';

		const url = buildCoclawUrl(botId, agentId, path);
		const parsed = parseCoclawUrl(url);

		expect(parsed).toEqual({ botId, agentId, path });
	});
});
