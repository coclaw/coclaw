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
	test('版本满足时返回 ok=true 和版本信息', async () => {
		const conn = mockConn({ version: '0.4.0', clawVersion: '2026.3.14', name: 'My PC', hostName: 'test-host' });
		const result = await checkPluginVersion(conn);
		expect(result).toEqual({ ok: true, version: '0.4.0', clawVersion: '2026.3.14', name: 'My PC', hostName: 'test-host' });
		expect(conn.request).toHaveBeenCalledWith('coclaw.info', {}, { timeout: 10_000 });
	});

	test('版本高于最低要求时返回 ok=true', async () => {
		const conn = mockConn({ version: '1.0.0', clawVersion: '2026.3.14' });
		expect((await checkPluginVersion(conn)).ok).toBe(true);
	});

	test('版本低于最低要求时返回 ok=false', async () => {
		const conn = mockConn({ version: '0.3.9' });
		const result = await checkPluginVersion(conn);
		expect(result.ok).toBe(false);
		expect(result.version).toBe('0.3.9');
	});

	test('版本 0.3.0 返回 ok=false', async () => {
		const conn = mockConn({ version: '0.3.0' });
		expect((await checkPluginVersion(conn)).ok).toBe(false);
	});

	test('RPC 调用失败时返回 ok=false（旧版插件无此方法）', async () => {
		const conn = mockConnError(new Error('method not found'));
		const result = await checkPluginVersion(conn);
		expect(result).toEqual({ ok: false, version: null, clawVersion: null, name: null, hostName: null });
	});

	test('返回结果中无 version 字段时返回 ok=false', async () => {
		const conn = mockConn({});
		const result = await checkPluginVersion(conn);
		expect(result.ok).toBe(false);
		expect(result.version).toBe(null);
	});

	test('version 非字符串时返回 ok=false', async () => {
		const conn = mockConn({ version: 42 });
		expect((await checkPluginVersion(conn)).ok).toBe(false);
	});

	test('clawVersion 缺失时返回 null', async () => {
		const conn = mockConn({ version: '0.5.0' });
		const result = await checkPluginVersion(conn);
		expect(result.ok).toBe(true);
		expect(result.clawVersion).toBe(null);
	});

	test('name 和 hostName 缺失时返回 null', async () => {
		const conn = mockConn({ version: '0.5.0' });
		const result = await checkPluginVersion(conn);
		expect(result.name).toBe(null);
		expect(result.hostName).toBe(null);
	});

	test('name 和 hostName 存在时正确返回', async () => {
		const conn = mockConn({ version: '0.5.0', name: 'Test', hostName: 'host1' });
		const result = await checkPluginVersion(conn);
		expect(result.name).toBe('Test');
		expect(result.hostName).toBe('host1');
	});

	test('version 缺失时仍返回 name 和 hostName', async () => {
		const conn = mockConn({ name: 'Test', hostName: 'host1' });
		const result = await checkPluginVersion(conn);
		expect(result.ok).toBe(false);
		expect(result.name).toBe('Test');
		expect(result.hostName).toBe('host1');
	});

	test('MIN_PLUGIN_VERSION 为 0.4.0', () => {
		expect(MIN_PLUGIN_VERSION).toBe('0.4.0');
	});
});
