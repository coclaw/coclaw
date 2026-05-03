/**
 * rpc-queues/ 启动期预热（B-stage1 plan-2）。
 *
 * 提供两个 async 函数，均**永不抛**——bridge.start 不能被启动期 fs 操作阻断：
 *
 * - `cleanupResiduals(dir, opts)`：mkdir { recursive: true } → readdir →
 *   按 `*.jsonl` 白名单逐个 unlink。任何子步失败均 warn 并跳过。
 *   白名单确保不会误删邻近文件（dump 设计：保留账本类小文件的扩展位）。
 *
 * - `measureDiskCap(dir, opts)`：fs.statfs → 公式
 *   `min(1GB, max(64MB, floor(free × 0.5)))`；statfs 抛错或缺失（Node <18.15）
 *   走 catch 路径回退固定 1GB。返回值由 bridge 暂存到 `__diskCap`，
 *   B-stage2 切 FBQ 时再消费（路径 TBD）。
 *
 * `fsOps` 注入仅供测试覆盖错误分支；生产路径默认 `fs.promises`，调用方不传。
 *
 * 行为契约（红线）：
 * - 不抛错，只 warn
 * - 不递归删——白名单仅 `*.jsonl`
 * - statfs 失败/缺失统一回退 1GB
 */

import fs from 'node:fs/promises';
import nodePath from 'node:path';

export const ONE_GB = 1024 * 1024 * 1024;
export const SIXTY_FOUR_MB = 64 * 1024 * 1024;

/**
 * @param {string} dir - 队列目录绝对路径
 * @param {object} [opts]
 * @param {object} [opts.logger] - pino 风格 logger（warn? / info? / error?）
 * @param {object} [opts.fsOps] - fs.promises 兼容子集（mkdir/readdir/unlink），仅供测试
 */
export async function cleanupResiduals(dir, { logger, fsOps = fs } = {}) {
	try {
		await fsOps.mkdir(dir, { recursive: true });
	}
	catch (err) {
		/* c8 ignore next -- ?./?? fallback：err 总是 Error，.message 总存在 */
		logger?.warn?.(`[coclaw] rpc-queues cleanup mkdir failed: ${err?.message ?? err}`);
		return;
	}

	let names;
	try {
		names = await fsOps.readdir(dir);
	}
	catch (err) {
		/* c8 ignore next -- ?./?? fallback：err 总是 Error，.message 总存在 */
		logger?.warn?.(`[coclaw] rpc-queues cleanup readdir failed: ${err?.message ?? err}`);
		return;
	}

	for (const name of names) {
		// readdir 默认返回 string[]，但若调用方注入 Buffer/Dirent 风格 mock，name.endsWith
		// 会抛出冲过"模块永不抛"红线。生产路径不会触发——纯防御。
		if (typeof name !== 'string') {
			logger?.warn?.(`[coclaw] rpc-queues unexpected non-string entry: ${typeof name}`);
			continue;
		}
		if (!name.endsWith('.jsonl')) continue;
		// nodePath.join 与 unlink 共享同一 try/catch：dir 若误传非 string（生产路径不会，
		// 但 typeof readdir 防御已挡 name 那一头），nodePath.join(dir, name) 会抛 TypeError，
		// 必须落在同一个 catch 里兜住才不破"模块永不抛"红线。
		try {
			const p = nodePath.join(dir, name);
			await fsOps.unlink(p);
		}
		catch (err) {
			/* c8 ignore next -- ?./?? fallback：err 总是 Error，.message 总存在 */
			logger?.warn?.(`[coclaw] rpc-queues unlink failed file=${name} err=${err?.message ?? err}`);
		}
	}
}

/**
 * @param {string} dir - 队列目录绝对路径（statfs 自动定位所在文件系统）
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {object} [opts.fsOps] - fs.promises 兼容子集（statfs），仅供测试
 * @returns {Promise<number>} diskCap 字节数；statfs 失败回退 1GB
 */
export async function measureDiskCap(dir, { logger, fsOps = fs } = {}) {
	try {
		const st = await fsOps.statfs(dir);
		const free = Number(st.bavail) * Number(st.bsize);
		// 真实生产环境（容器、网络挂载、ENOSYS 走 catch 之外的怪环境）下 statfs 偶有
		// 返回非 number / NaN / 负数字段的情况；Number(NaN/undefined) 乘任何东西都是 NaN，
		// floor(NaN * 0.5) = NaN，max/min 链路也会冒泡 NaN——不防御会让 __diskCap 为 NaN。
		if (!Number.isFinite(free) || free < 0) {
			/* c8 ignore next -- ?./?? fallback */
			logger?.warn?.(`[coclaw] rpc-queues statfs failed (non-finite, fallback 1GB): bavail=${st?.bavail} bsize=${st?.bsize}`);
			return ONE_GB;
		}
		return Math.min(ONE_GB, Math.max(SIXTY_FOUR_MB, Math.floor(free * 0.5)));
	}
	catch (err) {
		/* c8 ignore next -- ?./?? fallback：err 总是 Error 或 TypeError，.message 总存在 */
		logger?.warn?.(`[coclaw] rpc-queues statfs failed (fallback 1GB): ${err?.message ?? err}`);
		return ONE_GB;
	}
}
