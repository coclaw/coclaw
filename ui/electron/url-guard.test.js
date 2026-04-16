import { describe, test, expect } from 'vitest';
import { isTrustedUrl, TRUSTED_ORIGINS, REMOTE_URL, DEV_URL } from './url-guard.js';

describe('url-guard / isTrustedUrl', () => {
	test('远程业务域 origin 严格匹配', () => {
		expect(isTrustedUrl('https://im.coclaw.net')).toBe(true);
		expect(isTrustedUrl('https://im.coclaw.net/')).toBe(true);
		expect(isTrustedUrl('https://im.coclaw.net/chat/abc')).toBe(true);
		expect(isTrustedUrl('https://im.coclaw.net/?q=1')).toBe(true);
	});

	test('本地开发 origin 严格匹配', () => {
		expect(isTrustedUrl('http://localhost:5173')).toBe(true);
		expect(isTrustedUrl('http://localhost:5173/path')).toBe(true);
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
		expect(isTrustedUrl('http://localhost:5173')).toBe(true);
		expect(isTrustedUrl('http://localhost:5174')).toBe(false);
	});

	test('协议不一致不信任', () => {
		expect(isTrustedUrl('http://im.coclaw.net')).toBe(false);
		expect(isTrustedUrl('https://localhost:5173')).toBe(false);
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

	test('TRUSTED_ORIGINS 常量正确', () => {
		expect(TRUSTED_ORIGINS.has(REMOTE_URL)).toBe(true);
		expect(TRUSTED_ORIGINS.has(DEV_URL)).toBe(true);
		expect(TRUSTED_ORIGINS.size).toBe(2);
	});

	test('REMOTE_URL 和 DEV_URL 的常量值', () => {
		expect(REMOTE_URL).toBe('https://im.coclaw.net');
		expect(DEV_URL).toBe('http://localhost:5173');
	});
});
