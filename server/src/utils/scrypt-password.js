import crypto from 'node:crypto';
import { promisify } from 'node:util';

// 将 scrypt 的回调版本转换为 Promise 版本
const scryptAsync = promisify(crypto.scrypt);

// 设置一个最小密钥长度，以防止 "无效Base64" (length 0) 和 "截断哈希" (length < 32) 的漏洞。
// 32 字节 (256 bits) 是当前配置的 keyLength，也是一个合理的最小阈值。
// 将来需要时，在 passwordHash 中添加一个表达 keyLength 的参数，如 l=48。
// 但这只用于数据完整性，用于检测内部实现 bug，并不是用于防攻击。
const MIN_KEY_LENGTH = 32;

/**
 * scrypt 算法的核心参数。
 * N (cost): CPU/内存成本。必须是 2 的幂。 16384 (2^14) 是一个常见的默认值。
 * r (block size): 块大小。
 * p (parallelism): 并行化参数。
 *
 * OWASP 推荐值 (截至 2024):
 * - N=2^17 (131072), r=8, p=1 (高安全性)。约需 128M RAM
 * - N=2^16 (65536), r=8, p=1 (中等)。约需 64M RAM
 * - 我们选用 node 默认值 N=2^14 (16384) 。约需 16M RAM
 * 
 * maxmem 应为 N 所确定的内存需求的 2 倍。
 */
const SCRYPT_PARAMS = {
	// -----------------------------------------------------------------------
	// Node.js crypto.scrypt() 默认值:
	// N: 16384 (即 1 << 14)
	// r: 8
	// p: 1
	// maxmem: 33554432 (即 32 * 1024 * 1024, 或 32 MiB)
	// -----------------------------------------------------------------------
	N: 1 << 14, // 16384 (与 Node.js 默认值一致)
	r: 8, // (与 Node.js 默认值一致)
	p: 1, // (与 Node.js 默认值一致)
	keyLength: 32, // 256-bit (32 bytes)
	saltLength: 16, // 128-bit (16 bytes)
	maxmem: 32 * 1024 * 1024, // 32 MiB (与 Node.js 默认值一致)
};

/**
 * 将 Buffer 编码为 Base64 字符串 (移除 padding)
 * @param {Buffer} buf - 待编码的 Buffer
 * @returns {string} Base64 编码的字符串
 */
function encodeBase64(buf) {
	return buf.toString('base64').replace(/=+$/, '');
}

/**
 * 将 Base64 字符串解码为 Buffer
 * @param {string} str - 待解码的 Base64 字符串
 * @returns {Buffer} 解码后的 Buffer
 */
function decodeBase64(str) {
	// Buffer.from 会自动处理带或不带 padding 的 Base64 字符串
	return Buffer.from(str, 'base64');
}

/**
 * 对明文密码进行 scrypt 哈希。
 * 输出 PHC 格式的字符串: $scrypt$ln=<cost>,r=<blocksize>,p=<parallelism>$<salt>$<hash>
 * @param {string} password - 待哈希的明文密码
 * @returns {Promise<string>} PHC 格式的哈希字符串
 */
async function hashPassword(password) {
	const salt = crypto.randomBytes(SCRYPT_PARAMS.saltLength);
	const { N, r, p, keyLength, maxmem } = SCRYPT_PARAMS;

	const derivedKey = await scryptAsync(password, salt, keyLength, {
		N,
		r,
		p,
		maxmem,
	});

	const ln = Math.log2(N);
	const saltB64 = encodeBase64(salt);
	const hashB64 = encodeBase64(derivedKey);
	return `$scrypt$ln=${ln},r=${r},p=${p}$${saltB64}$${hashB64}`;
}

/**
 * 校验明文密码是否与 PHC 格式的 scrypt 哈希匹配。
 * 使用常量时间比较来防止时序攻击 (Timing Attack)。
 * @param {string} password - 用户输入的明文密码
 * @param {string} hashString - 数据库中存储的 PHC 哈希字符串
 * @returns {Promise<boolean>} 密码是否匹配
 */
async function verifyPassword(password, hashString) {
	try {
		// 1. 格式校验
		if (!hashString || typeof hashString !== 'string') {
			return false;
		}
		if (!hashString.startsWith('$scrypt$')) {
			return false;
		}

		const parts = hashString.split('$');
		// 结构应为: ['', 'scrypt', 'ln=14,r=8,p=1', 'saltBase64', 'hashBase64']
		if (parts.length !== 5) {
			return false;
		}

		// 2. 解析组件
		const paramsPart = parts[2];
		const saltB64 = parts[3];
		const hashB64 = parts[4];

		const salt = decodeBase64(saltB64);
		const storedKey = decodeBase64(hashB64);

		// 以防止 "无效Base64" (length 0) 和 "截断哈希" (length < 32) 的漏洞。
		if (storedKey.length < MIN_KEY_LENGTH) {
			return false;
		}

		// 3. 解析参数
		const paramMap = {};
		for (const kv of paramsPart.split(',')) {
			const [k, v] = kv.split('=');
			if (k && v) {
				paramMap[k] = Number(v);
			}
		}

		const { ln, r, p } = paramMap;

		if (!Number.isFinite(ln) || !Number.isFinite(r) || !Number.isFinite(p)) {
			return false;
		}

		// 4. 重构 scrypt 参数
		const N = 1 << ln;
		// 关键：keyLength 必须从存储的哈希中获取，而不是用默认值
		const keyLength = storedKey.length;
		const maxmem = SCRYPT_PARAMS.maxmem; // maxmem 是本地限制，使用当前配置

		// 5. 重新计算哈希
		const derivedKey = await scryptAsync(password, salt, keyLength, {
			N,
			r,
			p,
			maxmem,
		});

		// 6. 安全比较
		// 必须确保两个 Buffer 长度一致，否则 timingSafeEqual 会抛出异常
		if (storedKey.length !== derivedKey.length) {
			return false;
		}
		return crypto.timingSafeEqual(storedKey, derivedKey);
	} 
	catch (err) {
		// 捕获所有潜在错误 (如 Base64 解码失败, scrypt 计算失败等)
		// 任何错误都意味着校验失败，安全地返回 false
		console.error('Error during scrypt verification:', err);
		return false;
	}
}

/**
 * 封装了 scrypt 密码哈希和校验功能的对象
 */
export const scrypt = {
	hashPassword,
	verifyPassword,
};
