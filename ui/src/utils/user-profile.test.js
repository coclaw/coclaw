import { describe, expect, test } from 'vitest';

import { getUserAuthTypeLabel, getUserDisplayName, getUserLoginName } from './user-profile.js';

describe('user profile utils', () => {
	test('getUserDisplayName should prioritize user.name', () => {
		const user = {
			name: 'Alice',
			auth: {
				local: {
					loginName: 'alice-local',
				},
			},
		};
		expect(getUserDisplayName(user)).toBe('Alice');
	});

	test('getUserDisplayName should fallback to loginName then oauthName', () => {
		expect(getUserDisplayName({ auth: { local: { loginName: 'local-name' } } })).toBe('local-name');
		expect(getUserDisplayName({ auth: { github: { oauthName: 'octocat' } } })).toBe('octocat');
	});

	test('getUserLoginName should return local login or first oauth name', () => {
		expect(getUserLoginName({ auth: { local: { loginName: 'test' } } })).toBe('test');
		expect(getUserLoginName({ auth: { wechat: { oauthName: 'wx-user' } } })).toBe('wx-user');
	});

	test('getUserAuthTypeLabel should map known and unknown types', () => {
		expect(getUserAuthTypeLabel({ authType: 'local' })).toBe('本地账号');
		expect(getUserAuthTypeLabel({ authType: 'github' })).toBe('第三方(github)');
		expect(getUserAuthTypeLabel({})).toBe('未知');
	});

	// --- 未覆盖分支补充 ---

	test('getUserLoginName 对非对象输入返回空字符串', () => {
		expect(getUserLoginName(null)).toBe('');
		expect(getUserLoginName(undefined)).toBe('');
		expect(getUserLoginName('string')).toBe('');
		expect(getUserLoginName(42)).toBe('');
	});

	test('getUserDisplayName 对非对象输入返回空字符串', () => {
		expect(getUserDisplayName(null)).toBe('');
		expect(getUserDisplayName(undefined)).toBe('');
		expect(getUserDisplayName(123)).toBe('');
	});

	test('getUserDisplayName 无 name 且无 auth 时回退到 Unknown User', () => {
		expect(getUserDisplayName({})).toBe('Unknown User');
		expect(getUserDisplayName({ auth: {} })).toBe('Unknown User');
	});

	test('getUserLoginName auth 中无 local 且外部 oauth 无 oauthName 时返回空', () => {
		// auth 存在但 entries 无有效 oauthName
		expect(getUserLoginName({ auth: { github: {} } })).toBe('');
		expect(getUserLoginName({ auth: { github: { someProp: 'x' } } })).toBe('');
	});

	test('getUserLoginName 对无效 auth 返回空', () => {
		expect(getUserLoginName({ auth: null })).toBe('');
		expect(getUserLoginName({ auth: 'invalid' })).toBe('');
	});

	test('getUserAuthTypeLabel 使用 t 函数进行翻译', () => {
		const t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key;
		expect(getUserAuthTypeLabel({ authType: 'local' }, t)).toBe('profile.authTypeLocal');
		expect(getUserAuthTypeLabel({ authType: 'github' }, t)).toBe('profile.authTypeThirdParty:{"type":"github"}');
		expect(getUserAuthTypeLabel({}, t)).toBe('profile.authTypeUnknown');
	});
});
