// src/utils/scrypt.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scrypt } from './scrypt-password.js';

test.describe('scrypt utility', function () {
	// 定义一个固定的密码用于多个测试
	const testPassword = 'my-s3cr3t-p@ssw0rd!';

	test.describe('hashPassword()', function () {
		test('should generate a valid PHC format string', async function () {
			const hash = await scrypt.hashPassword(testPassword);

			// 1. 检查基础类型和前缀
			assert.strictEqual(typeof hash, 'string', 'Hash should be a string');
			assert(hash.startsWith('$scrypt$'), 'Hash should start with $scrypt$');

			// 2. 检查 PHC 格式的 5 个部分
			const parts = hash.split('$');
			assert.strictEqual(parts.length, 5, 'Hash string should have 5 parts');

			// 3. 检查各个部分
			assert.strictEqual(parts[0], '', 'Part 0 should be empty');
			assert.strictEqual(parts[1], 'scrypt', 'Part 1 should be "scrypt"');
			assert(
				parts[2].startsWith('ln=14,r=8,p=1'),
				'Part 2 (params) should match config'
			);
			assert(parts[3].length > 0, 'Part 3 (salt) should not be empty');
			assert(parts[4].length > 0, 'Part 4 (hash) should not be empty');
		});

		test('should produce different hashes for the same password (due to random salt)', async function () {
			const hash1 = await scrypt.hashPassword(testPassword);
			const hash2 = await scrypt.hashPassword(testPassword);

			assert.notStrictEqual(hash1, hash2, 'Hashes should be different');
		});
	});

	test.describe('verifyPassword()', function () {
		test('should return true for a correct password', async function () {
			const hash = await scrypt.hashPassword(testPassword);
			const isValid = await scrypt.verifyPassword(testPassword, hash);
			assert.strictEqual(isValid, true, 'Verification should succeed');
		});

		test('should return false for an incorrect password', async function () {
			const hash = await scrypt.hashPassword(testPassword);
			const isValid = await scrypt.verifyPassword('wrong-password', hash);
			assert.strictEqual(isValid, false, 'Verification should fail');
		});

		test('should correctly handle an empty password', async function () {
			const emptyPassword = '';
			const hash = await scrypt.hashPassword(emptyPassword);

			const isCorrect = await scrypt.verifyPassword(emptyPassword, hash);
			assert.strictEqual(isCorrect, true, 'Should validate empty password');

			const isIncorrect = await scrypt.verifyPassword('not-empty', hash);
			assert.strictEqual(
				isIncorrect,
				false,
				'Should fail for non-empty password'
			);
		});

		test('should return false for various invalid or malformed hash strings', async function (t) {
			const password = 'any-password';

			const testCases = {
				null: null,
				undefined: undefined,
				'empty string': '',
				'random string': 'not-a-real-hash',
				'wrong prefix': '$argon2$ln=14,r=8,p=1$salt$hash',
				'wrong part count': '$scrypt$ln=1$salt$hash$extra-part',
				'invalid base64 salt': '$scrypt$ln=14,r=8,p=1$!@#$Zm9v',
				'invalid base64 hash': '$scrypt$ln=14,r=8,p=1$c2FsdA==$!@#',
				'invalid params (non-numeric)': '$scrypt$ln=foo,r=bar,p=baz$c2FsdA==$Zm9v',
				'missing params': '$scrypt$ln=14,r=8$c2FsdA==$Zm9v',
				'invalid scrypt numeric params (r=0)': '$scrypt$ln=14,r=0,p=1$c2FsdA==$wN+S0sgP5gq5tziGPCmfmO5C3nNVIb1t1mJv5yWz+j4=',
			};

			for (const [desc, hash] of Object.entries(testCases)) {
				await t.test(`when hash is ${desc}`, async function () {
					// verifyPassword 应该总是安全返回 false，而不是抛出异常
					const isValid = await scrypt.verifyPassword(password, hash);
					assert.strictEqual(isValid, false);
				});
			}
		});

		test('should return false when ln/r/p are non-finite', async function () {
			// 参数中包含非数值（如 NaN）
			const hash = '$scrypt$ln=NaN,r=8,p=1$c2FsdA==$wN+S0sgP5gq5tziGPCmfmO5C3nNVIb1t1mJv5yWz+j4=';
			const isValid = await scrypt.verifyPassword('any', hash);
			assert.strictEqual(isValid, false);
		});

		test('should return false when storedKey length differs from derivedKey length', async function () {
			// 使用有效参数但手动构造不匹配长度的哈希
			// 先生成一个正常哈希，然后篡改 keyLength
			const realHash = await scrypt.hashPassword('test');
			const parts = realHash.split('$');
			// 用一个超长的 base64 哈希替换（48 字节而非 32 字节）
			const longKey = Buffer.alloc(48, 0xff).toString('base64').replace(/=+$/, '');
			const tampered = `$scrypt$${parts[2]}$${parts[3]}$${longKey}`;
			const isValid = await scrypt.verifyPassword('test', tampered);
			assert.strictEqual(isValid, false);
		});

		test('should return false and log error when scrypt throws', async function () {
			// 使用一个会导致 scrypt 内部异常的参数组合
			// ln=30 → N=2^30 → 需要大量内存，会超过 maxmem
			const hugeN = '$scrypt$ln=30,r=8,p=1$c2FsdA==$wN+S0sgP5gq5tziGPCmfmO5C3nNVIb1t1mJv5yWz+j4=';
			const origError = console.error;
			const logged = [];
			console.error = (...args) => logged.push(args);
			try {
				const isValid = await scrypt.verifyPassword('any', hugeN);
				assert.strictEqual(isValid, false);
				assert.ok(logged.length > 0, '应有错误日志输出');
			} finally {
				console.error = origError;
			}
		});

		test('should return false for a hash truncated (but valid base64)', async function () {
			const hash = await scrypt.hashPassword(testPassword);
			const parts = hash.split('$');
			const saltB64 = parts[3];
			const hashB64 = parts[4];

			// 故意截断哈希部分（移除最后 4 个字符）
			const truncatedHashB64 = hashB64.slice(0, -4);
			const truncatedHash = `$scrypt$${parts[2]}$${saltB64}$${truncatedHashB64}`;

			// 即使 base64 仍然（可能）有效，但哈希是错误的
			const isValid = await scrypt.verifyPassword(testPassword, truncatedHash);
			assert.strictEqual(
				isValid,
				false,
				'Verification should fail for truncated hash'
			);
		});
	});
});
