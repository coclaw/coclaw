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
});
