import { describe, test, expect } from 'vitest';
import {
	validateLoginName,
	RESERVED_NAMES,
	MAX_LEN,
	FORMAT_RE,
} from './login-name.js';

describe('validateLoginName', () => {
	describe('valid names', () => {
		const cases = [
			'abc', 'a'.repeat(MAX_LEN), 'hello', 'user123',
			'foo-bar', 'foo.bar', 'foo_bar', 'a1-b2.c3_d4',
		];
		test.each(cases)('accepts "%s"', (name) => {
			expect(validateLoginName(name).valid).toBe(true);
		});
	});

	describe('non-string input', () => {
		test.each([null, undefined, 123, true])('rejects %s', (val) => {
			const r = validateLoginName(val);
			expect(r.valid).toBe(false);
			expect(r.code).toBe('INVALID_INPUT');
		});
	});

	describe('length', () => {
		test('rejects too short', () => {
			expect(validateLoginName('ab')).toMatchObject({ valid: false, code: 'LOGIN_NAME_LENGTH' });
		});
		test('rejects too long', () => {
			expect(validateLoginName('a'.repeat(MAX_LEN + 1))).toMatchObject({ valid: false, code: 'LOGIN_NAME_LENGTH' });
		});
	});

	describe('FORMAT_RE', () => {
		const shouldMatch = [
			['abc', '最短'], ['a'.repeat(28), '最长'],
			['a-b', '连字符'], ['a.b', '点'], ['a_b', '下划线'],
			['a-b.c_d', '交替特殊字符'], ['ABC', '全大写'], ['123', '全数字'],
		];
		test.each(shouldMatch)('matches "%s" (%s)', (input) => {
			expect(FORMAT_RE.test(input)).toBe(true);
		});

		const shouldNotMatch = [
			['_ab', '下划线开头'], ['-ab', '连字符开头'], ['.ab', '点开头'],
			['ab_', '下划线结尾'], ['ab-', '连字符结尾'], ['ab.', '点结尾'],
			['a..b', '连续点'], ['a--b', '连续连字符'], ['a__b', '连续下划线'],
			['a.-b', '点+连字符'], ['a-.b', '连字符+点'],
			['a_-b', '下划线+连字符'], ['a._b', '点+下划线'],
			['a b', '空格'], ['a@b', '@'], ['a!b', '!'],
			['ab', '2字符'], ['a'.repeat(29), '29字符'],
			['---', '全连字符'], ['...', '全点'],
		];
		test.each(shouldNotMatch)('rejects "%s" (%s)', (input) => {
			expect(FORMAT_RE.test(input)).toBe(false);
		});
	});

	describe('reserved names', () => {
		test('rejects "admin"', () => {
			expect(validateLoginName('admin')).toMatchObject({ valid: false, code: 'LOGIN_NAME_RESERVED' });
		});
		test('case-insensitive', () => {
			expect(validateLoginName('Admin')).toMatchObject({ valid: false, code: 'LOGIN_NAME_RESERVED' });
		});
		test('all reserved names are lowercase', () => {
			for (const name of RESERVED_NAMES) {
				expect(name).toBe(name.toLowerCase());
			}
		});
	});
});
