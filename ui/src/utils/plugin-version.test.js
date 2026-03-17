import { describe, test, expect, vi } from 'vitest';
import { checkPluginVersion, MIN_PLUGIN_VERSION } from './plugin-version.js';

function mockConn(response) {
	return {
		request: vi.fn().mockResolvedValue(response),
	};
}

function mockConnError(err) {
	return {
		request: vi.fn().mockRejectedValue(err),
	};
}

describe('checkPluginVersion', () => {
	test('版本满足时返回 true', async () => {
		const conn = mockConn({ version: '0.4.0' });
		expect(await checkPluginVersion(conn)).toBe(true);
		expect(conn.request).toHaveBeenCalledWith('coclaw.info', {});
	});

	test('版本高于最低要求时返回 true', async () => {
		const conn = mockConn({ version: '1.0.0' });
		expect(await checkPluginVersion(conn)).toBe(true);
	});

	test('版本低于最低要求时返回 false', async () => {
		const conn = mockConn({ version: '0.3.9' });
		expect(await checkPluginVersion(conn)).toBe(false);
	});

	test('版本 0.3.0 返回 false', async () => {
		const conn = mockConn({ version: '0.3.0' });
		expect(await checkPluginVersion(conn)).toBe(false);
	});

	test('RPC 调用失败时返回 false（旧版插件无此方法）', async () => {
		const conn = mockConnError(new Error('method not found'));
		expect(await checkPluginVersion(conn)).toBe(false);
	});

	test('返回结果中无 version 字段时返回 false', async () => {
		const conn = mockConn({});
		expect(await checkPluginVersion(conn)).toBe(false);
	});

	test('version 非字符串时返回 false', async () => {
		const conn = mockConn({ version: 42 });
		expect(await checkPluginVersion(conn)).toBe(false);
	});

	test('MIN_PLUGIN_VERSION 为 0.4.0', () => {
		expect(MIN_PLUGIN_VERSION).toBe('0.4.0');
	});
});
