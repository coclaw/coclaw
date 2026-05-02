/**
 * 原子文件写入工具。
 * 通过 write-to-tmp + rename 模式确保写入过程中崩溃不会损坏目标文件。
 *
 * 参照 OpenClaw writeTextAtomic / writeJsonAtomic 实现。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
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
		// fsync tmp：确保数据真正落盘后再 rename。系统断电场景下，仅 writeFile 后
		// 内核 buffer 可能还没刷到磁盘，rename 完成但文件内容是 0 字节 / 旧数据
		const tmpFh = await fs.open(tmp, 'r+');
		try { await tmpFh.sync(); } finally { await tmpFh.close(); }
		await fs.rename(tmp, filePath);
		/* c8 ignore next -- chmod 在正常文件系统上不会失败 */
		try { await fs.chmod(filePath, mode); } catch { /* ignore */ }
		// fsync 父目录持久化 rename 自身：POSIX 下保证 rename 元数据落盘
		/* c8 ignore start -- 父目录 fsync 在 Windows / 异常文件系统上忽略 */
		try {
			const dirFh = await fs.open(nodePath.dirname(filePath), 'r');
			try { await dirFh.sync(); } finally { await dirFh.close(); }
		} catch { /* Windows / 非 POSIX 文件系统忽略 */ }
		/* c8 ignore stop */
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

/**
 * 同步版 atomicWriteFile：仅供 device-identity 等启动期同步路径使用，
 * 行为与 atomicWriteFile 等价（write-to-tmp + rename + finally cleanup）。
 *
 * @param {string} filePath - 目标文件路径
 * @param {string | Buffer} content - 文件内容
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600] - 文件权限
 * @param {number} [opts.dirMode] - 父目录权限
 * @param {string} [opts.encoding='utf8'] - 写入编码
 */
function atomicWriteFileSync(filePath, content, opts) {
	const mode = opts?.mode ?? 0o600;
	const encoding = opts?.encoding ?? 'utf8';
	const mkdirOpts = { recursive: true };
	if (opts?.dirMode != null) {
		mkdirOpts.mode = opts.dirMode;
	}

	nodeFs.mkdirSync(nodePath.dirname(filePath), mkdirOpts);

	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		nodeFs.writeFileSync(tmp, content, { encoding, mode });
		/* c8 ignore next -- chmod 在正常文件系统上不会失败 */
		try { nodeFs.chmodSync(tmp, mode); } catch { /* ignore */ }
		// fsync tmp：与 async 版同理，确保数据真正落盘后再 rename
		const tmpFd = nodeFs.openSync(tmp, 'r+');
		try { nodeFs.fsyncSync(tmpFd); } finally { nodeFs.closeSync(tmpFd); }
		nodeFs.renameSync(tmp, filePath);
		/* c8 ignore next -- chmod 在正常文件系统上不会失败 */
		try { nodeFs.chmodSync(filePath, mode); } catch { /* ignore */ }
		/* c8 ignore start -- 父目录 fsync 在 Windows / 异常文件系统上忽略 */
		try {
			const dirFd = nodeFs.openSync(nodePath.dirname(filePath), 'r');
			try { nodeFs.fsyncSync(dirFd); } finally { nodeFs.closeSync(dirFd); }
		} catch { /* Windows / 非 POSIX 文件系统忽略 */ }
		/* c8 ignore stop */
	} finally {
		// 确保临时文件不残留（rename 成功后 tmp 已不存在，rmSync force=true 会无声忽略）
		try { nodeFs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
	}
}

export { atomicWriteFile, atomicWriteJsonFile, atomicWriteFileSync };
