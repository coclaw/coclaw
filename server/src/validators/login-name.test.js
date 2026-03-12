import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	validateLoginName,
	RESERVED_NAMES,
	MIN_LEN,
	MAX_LEN,
	FORMAT_RE,
} from './login-name.js';

describe('validateLoginName', () => {
	// ---- 合法值 ----
	const validNames = [
		'abc',                  // 最短
		'a'.repeat(MAX_LEN),   // 最长
		'hello',
		'user123',
		'foo-bar',
		'foo.bar',
		'foo_bar',
		'a1-b2.c3_d4',
		'Ab', // 不够长，稍后在非法里测
	];

	// 去掉长度不足的
	for (const name of validNames.filter((n) => n.length >= MIN_LEN)) {
		test(`accepts "${name}"`, () => {
			const result = validateLoginName(name);
			assert.equal(result.valid, true, `expected "${name}" to be valid`);
		});
	}

	// ---- 非法值 ----
	describe('rejects non-string input', () => {
		for (const val of [null, undefined, 123, true, {}, []]) {
			test(`rejects ${JSON.stringify(val)}`, () => {
				const result = validateLoginName(val);
				assert.equal(result.valid, false);
				assert.equal(result.code, 'INVALID_INPUT');
			});
		}
	});

	describe('length constraints', () => {
		test('rejects too short', () => {
			const result = validateLoginName('ab');
			assert.equal(result.valid, false);
			assert.equal(result.code, 'LOGIN_NAME_LENGTH');
		});

		test('rejects empty string', () => {
			const result = validateLoginName('');
			assert.equal(result.valid, false);
			assert.equal(result.code, 'LOGIN_NAME_LENGTH');
		});

		test('rejects too long', () => {
			const result = validateLoginName('a'.repeat(MAX_LEN + 1));
			assert.equal(result.valid, false);
			assert.equal(result.code, 'LOGIN_NAME_LENGTH');
		});

		test(`accepts exactly ${MIN_LEN} chars`, () => {
			assert.equal(validateLoginName('abc').valid, true);
		});

		test(`accepts exactly ${MAX_LEN} chars`, () => {
			assert.equal(validateLoginName('a'.repeat(MAX_LEN)).valid, true);
		});
	});

	describe('format constraints', () => {
		const invalidFormats = [
			['_abc', 'starts with underscore'],
			['-abc', 'starts with hyphen'],
			['.abc', 'starts with dot'],
			['abc_', 'ends with underscore'],
			['abc-', 'ends with hyphen'],
			['abc.', 'ends with dot'],
			['a..b', 'consecutive dots'],
			['a--b', 'consecutive hyphens'],
			['a__b', 'consecutive underscores'],
			['a-.b', 'consecutive mixed specials'],
			['a._b', 'consecutive mixed specials 2'],
			['a b c', 'contains space'],
			['ab@cd', 'contains @'],
			['ab#cd', 'contains #'],
			['你好世界', 'contains CJK chars'],
		];

		for (const [name, reason] of invalidFormats) {
			test(`rejects "${name}" (${reason})`, () => {
				const result = validateLoginName(name);
				assert.equal(result.valid, false, `expected "${name}" to be invalid`);
				assert.equal(result.code, 'LOGIN_NAME_FORMAT');
			});
		}
	});

	describe('FORMAT_RE regex direct tests', () => {
		const shouldMatch = [
			['abc', '最短合法 (3 字符)'],
			['a'.repeat(28), '最长合法 (28 字符)'],
			['aB1', '混合大小写+数字'],
			['a-b', '中间单个连字符'],
			['a.b', '中间单个点'],
			['a_b', '中间单个下划线'],
			['a-b.c_d', '交替使用三种特殊字符'],
			['x1.y2-z3_w4', '字母数字与特殊字符交替'],
			['ABC', '全大写'],
			['123', '全数字'],
			['a1b2c3', '字母数字交替'],
		];

		for (const [input, desc] of shouldMatch) {
			test(`FORMAT_RE matches "${input}" (${desc})`, () => {
				assert.ok(FORMAT_RE.test(input), `expected "${input}" to match`);
			});
		}

		const shouldNotMatch = [
			// 首字符限制
			['_ab', '下划线开头'],
			['-ab', '连字符开头'],
			['.ab', '点开头'],
			// 尾字符限制
			['ab_', '下划线结尾'],
			['ab-', '连字符结尾'],
			['ab.', '点结尾'],
			// 连续特殊字符
			['a..b', '连续点'],
			['a--b', '连续连字符'],
			['a__b', '连续下划线'],
			['a.-b', '点+连字符'],
			['a-.b', '连字符+点'],
			['a_-b', '下划线+连字符'],
			['a-_b', '连字符+下划线'],
			['a_.b', '下划线+点'],
			['a._b', '点+下划线'],
			// 非法字符
			['a b', '空格'],
			['a@b', '@'],
			['a!b', '!'],
			['a/b', '/'],
			['a+b', '+'],
			['a=b', '='],
			['你好吗', '中文'],
			// 超长 (29 字符)
			['a'.repeat(29), '超过 28 字符'],
			// 过短 (2 字符)
			['ab', '只有 2 字符'],
			// 只有特殊字符（长度足够但首尾非法）
			['---', '全连字符'],
			['...', '全点'],
			['___', '全下划线'],
		];

		for (const [input, desc] of shouldNotMatch) {
			test(`FORMAT_RE rejects "${input}" (${desc})`, () => {
				assert.ok(!FORMAT_RE.test(input), `expected "${input}" NOT to match`);
			});
		}
	});

	describe('reserved names', () => {
		test('rejects exact reserved name', () => {
			const result = validateLoginName('admin');
			assert.equal(result.valid, false);
			assert.equal(result.code, 'LOGIN_NAME_RESERVED');
		});

		test('rejects reserved name case-insensitively', () => {
			const result = validateLoginName('Admin');
			assert.equal(result.valid, false);
			assert.equal(result.code, 'LOGIN_NAME_RESERVED');
		});

		test('rejects all uppercase reserved name', () => {
			const result = validateLoginName('ROOT');
			assert.equal(result.valid, false);
			assert.equal(result.code, 'LOGIN_NAME_RESERVED');
		});

		test('RESERVED_NAMES set is non-empty', () => {
			assert.ok(RESERVED_NAMES.size > 0);
		});

		test('all reserved names are lowercase', () => {
			for (const name of RESERVED_NAMES) {
				assert.equal(name, name.toLowerCase(), `reserved name "${name}" should be lowercase`);
			}
		});

		test('all reserved names pass format check (except length)', () => {
			for (const name of RESERVED_NAMES) {
				if (name.length >= MIN_LEN && name.length <= MAX_LEN) {
					assert.ok(FORMAT_RE.test(name), `reserved name "${name}" should match format regex`);
				}
			}
		});
	});
});
