import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockGetSources = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('electron', () => ({
	desktopCapturer: { getSources: mockGetSources },
}));

const { setupPermissions } = await import('./permissions.js');

describe('permissions 同步 setPermissionCheckHandler', () => {
	let check;
	beforeEach(() => {
		let fn = null;
		setupPermissions({
			setPermissionCheckHandler: (f) => { fn = f; },
			setPermissionRequestHandler: () => {},
			setDisplayMediaRequestHandler: () => {},
		});
		check = fn;
	});

	test('白名单权限 + im.coclaw.net → true', () => {
		expect(check(null, 'media', 'https://im.coclaw.net/')).toBe(true);
	});
	test('白名单权限 + *.coclaw.net 子域 → true', () => {
		expect(check(null, 'notifications', 'https://foo.coclaw.net/')).toBe(true);
	});
	test('白名单权限 + 非信任域 → false', () => {
		expect(check(null, 'media', 'https://evil.com/')).toBe(false);
	});
	test('非白名单权限即使信任域 → false（最小权限）', () => {
		expect(check(null, 'geolocation', 'https://im.coclaw.net/')).toBe(false);
		expect(check(null, 'midi-sysex', 'https://im.coclaw.net/')).toBe(false);
		expect(check(null, 'idle-detection', 'https://im.coclaw.net/')).toBe(false);
	});
	test('前缀伪装域名不能绕过（im.coclaw.net.evil.com）', () => {
		expect(check(null, 'media', 'https://im.coclaw.net.evil.com/')).toBe(false);
	});
	test('无效 URL → false，不抛', () => {
		expect(() => check(null, 'media', 'not a url')).not.toThrow();
		expect(check(null, 'media', 'not a url')).toBe(false);
	});
	test('clipboard 两种权限均在白名单', () => {
		expect(check(null, 'clipboard-read', 'https://im.coclaw.net/')).toBe(true);
		expect(check(null, 'clipboard-sanitized-write', 'https://im.coclaw.net/')).toBe(true);
	});
	test('display-capture + fullscreen 在白名单', () => {
		expect(check(null, 'display-capture', 'https://im.coclaw.net/')).toBe(true);
		expect(check(null, 'fullscreen', 'https://im.coclaw.net/')).toBe(true);
	});
});

describe('permissions 异步 setPermissionRequestHandler', () => {
	let request;
	beforeEach(() => {
		let fn = null;
		setupPermissions({
			setPermissionCheckHandler: () => {},
			setPermissionRequestHandler: (f) => { fn = f; },
			setDisplayMediaRequestHandler: () => {},
		});
		request = fn;
	});

	test('媒体权限 + im.coclaw.net → callback(true)', () => {
		const cb = vi.fn();
		request(null, 'media', cb, { requestingUrl: 'https://im.coclaw.net/chat' });
		expect(cb).toHaveBeenCalledWith(true);
	});
	test('path 包含 im.coclaw.net 字样但 host 非信任 → callback(false)（防路径绕过）', () => {
		const cb = vi.fn();
		request(null, 'media', cb, { requestingUrl: 'https://evil.com/?ref=im.coclaw.net' });
		expect(cb).toHaveBeenCalledWith(false);
	});
	test('非白名单权限 → callback(false)', () => {
		const cb = vi.fn();
		request(null, 'geolocation', cb, { requestingUrl: 'https://im.coclaw.net/' });
		expect(cb).toHaveBeenCalledWith(false);
	});
	test('details 为空 → callback(false)', () => {
		const cb = vi.fn();
		request(null, 'media', cb, {});
		expect(cb).toHaveBeenCalledWith(false);
	});
	test('details.requestingUrl undefined → callback(false)，不抛', () => {
		const cb = vi.fn();
		expect(() => request(null, 'media', cb, { requestingUrl: undefined })).not.toThrow();
		expect(cb).toHaveBeenCalledWith(false);
	});
});

describe('permissions setDisplayMediaRequestHandler', () => {
	let display;
	beforeEach(() => {
		let fn = null;
		setupPermissions({
			setPermissionCheckHandler: () => {},
			setPermissionRequestHandler: () => {},
			setDisplayMediaRequestHandler: (f) => { fn = f; },
		});
		display = fn;
	});

	test('有源 → callback 传入 sources[0]', async () => {
		mockGetSources.mockResolvedValueOnce([{ id: 'screen:0:0' }, { id: 'screen:1:0' }]);
		const cb = vi.fn();
		await display(null, cb);
		expect(cb).toHaveBeenCalledWith({ video: { id: 'screen:0:0' } });
	});
	test('无源 → callback({})', async () => {
		mockGetSources.mockResolvedValueOnce([]);
		const cb = vi.fn();
		await display(null, cb);
		expect(cb).toHaveBeenCalledWith({});
	});
	test('getSources 抛错 → callback({})，不向上抛', async () => {
		mockGetSources.mockRejectedValueOnce(new Error('boom'));
		const cb = vi.fn();
		await display(null, cb);
		expect(cb).toHaveBeenCalledWith({});
	});
});
