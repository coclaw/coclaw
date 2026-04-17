import { describe, test, expect } from 'vitest';
import { isTrustedUrl, REMOTE_URL, DEV_URL } from './url-guard.js';

describe('url-guard / isTrustedUrl — 生产模式（默认）', () => {
	test('远程业务域 origin 严格匹配', () => {
		expect(isTrustedUrl('https://im.coclaw.net')).toBe(true);
		expect(isTrustedUrl('https://im.coclaw.net/')).toBe(true);
		expect(isTrustedUrl('https://im.coclaw.net/chat/abc')).toBe(true);
		expect(isTrustedUrl('https://im.coclaw.net/?q=1')).toBe(true);
	});

	test('本地开发地址默认不信任（防生产环境 5173 端口被占用攻击）', () => {
		expect(isTrustedUrl('http://localhost:5173')).toBe(false);
		expect(isTrustedUrl('http://localhost:5173/path')).toBe(false);
	});

	test('前缀绕过攻击：子域名前缀不信任', () => {
		expect(isTrustedUrl('https://im.coclaw.net.evil.com')).toBe(false);
		expect(isTrustedUrl('https://im.coclaw.net.attacker.io/x')).toBe(false);
	});

	test('后缀绕过攻击：域名后缀不信任', () => {
		expect(isTrustedUrl('https://evil.com/im.coclaw.net')).toBe(false);
		expect(isTrustedUrl('https://evil.com?ref=https://im.coclaw.net')).toBe(false);
	});

	test('端口不一致不信任（origin 含端口）', () => {
		expect(isTrustedUrl('https://im.coclaw.net:8443')).toBe(false);
	});

	test('协议不一致不信任', () => {
		expect(isTrustedUrl('http://im.coclaw.net')).toBe(false);
	});

	test('子域名不信任（除非显式加入白名单）', () => {
		expect(isTrustedUrl('https://admin.coclaw.net')).toBe(false);
		expect(isTrustedUrl('https://api.im.coclaw.net')).toBe(false);
	});

	test('无效 URL 返回 false 且不抛', () => {
		expect(isTrustedUrl('not a url')).toBe(false);
		expect(isTrustedUrl('')).toBe(false);
		expect(isTrustedUrl('://noproto')).toBe(false);
	});

	test('非字符串输入不抛，返回 false', () => {
		expect(isTrustedUrl(null)).toBe(false);
		expect(isTrustedUrl(undefined)).toBe(false);
		expect(isTrustedUrl(123)).toBe(false);
	});

	test('自定义协议不在白名单（coclaw:// 交给 deep-link 处理）', () => {
		expect(isTrustedUrl('coclaw://chat/abc')).toBe(false);
		expect(isTrustedUrl('file:///etc/passwd')).toBe(false);
	});

	test('REMOTE_URL 和 DEV_URL 的常量值', () => {
		expect(REMOTE_URL).toBe('https://im.coclaw.net');
		expect(DEV_URL).toBe('http://localhost:5173');
	});
});

describe('url-guard / isTrustedUrl — allowDev=true（开发模式）', () => {
	test('本地开发地址被信任', () => {
		expect(isTrustedUrl('http://localhost:5173', { allowDev: true })).toBe(true);
		expect(isTrustedUrl('http://localhost:5173/path', { allowDev: true })).toBe(true);
	});

	test('远程业务域仍被信任', () => {
		expect(isTrustedUrl('https://im.coclaw.net', { allowDev: true })).toBe(true);
	});

	test('其它端口仍不信任', () => {
		expect(isTrustedUrl('http://localhost:5174', { allowDev: true })).toBe(false);
	});

	test('协议不一致仍不信任', () => {
		expect(isTrustedUrl('https://localhost:5173', { allowDev: true })).toBe(false);
	});

	test('攻击者域名仍不信任', () => {
		expect(isTrustedUrl('https://im.coclaw.net.evil.com', { allowDev: true })).toBe(false);
	});

	test('无效 URL 仍返回 false（allowDev 不影响 URL 解析失败路径）', () => {
		expect(isTrustedUrl('not a url', { allowDev: true })).toBe(false);
		expect(isTrustedUrl(null, { allowDev: true })).toBe(false);
	});

	test('allowDev=false 显式传与不传等价（生产模式）', () => {
		expect(isTrustedUrl('http://localhost:5173', { allowDev: false })).toBe(false);
		expect(isTrustedUrl('https://im.coclaw.net', { allowDev: false })).toBe(true);
	});
});
