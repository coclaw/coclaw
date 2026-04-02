/**
 * 原子文件写入工具。
 * 通过 write-to-tmp + rename 模式确保写入过程中崩溃不会损坏目标文件。
 *
 * 参照 OpenClaw writeTextAtomic / writeJsonAtomic 实现。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';

/**
 * 原子写入任意文件。
 * 先写入同目录临时文件，再 rename 覆盖目标（POSIX 原子操作）。
 *
 * @param {string} filePath - 目标文件路径
 * @param {string | Buffer} content - 文件内容
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600] - 文件权限
 * @param {number} [opts.dirMode] - 父目录权限（自动创建时使用）
 * @param {string} [opts.encoding='utf8'] - 写入编码
 */
async function atomicWriteFile(filePath, content, opts) {
	const mode = opts?.mode ?? 0o600;
	const encoding = opts?.encoding ?? 'utf8';
	const mkdirOpts = { recursive: true };
	if (opts?.dirMode != null) {
		mkdirOpts.mode = opts.dirMode;
	}

	await fs.mkdir(nodePath.dirname(filePath), mkdirOpts);

	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, content, { encoding, mode });
		// best-effort chmod（部分平台 writeFile 的 mode 可能不生效）
		/* c8 ignore next -- chmod 在正常文件系统上不会失败 */
		try { await fs.chmod(tmp, mode); } catch { /* ignore */ }
		await fs.rename(tmp, filePath);
		/* c8 ignore next -- chmod 在正常文件系统上不会失败 */
		try { await fs.chmod(filePath, mode); } catch { /* ignore */ }
	} finally {
		// 确保临时文件不残留
		await fs.rm(tmp, { force: true }).catch(() => {});
	}
}

/**
 * 原子写入 JSON 文件。
 * 使用 2 空格缩进 + 尾部换行，与 OpenClaw 配置文件风格一致。
 *
 * @param {string} filePath - 目标文件路径
 * @param {*} value - 要序列化的值
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600] - 文件权限
 * @param {number} [opts.dirMode] - 父目录权限
 */
async function atomicWriteJsonFile(filePath, value, opts) {
	const text = JSON.stringify(value, null, 2) + '\n';
	await atomicWriteFile(filePath, text, opts);
}

export { atomicWriteFile, atomicWriteJsonFile };
