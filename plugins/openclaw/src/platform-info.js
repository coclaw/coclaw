import os from 'node:os';
import process from 'node:process';

// 模块级缓存：所有字段在进程生命周期内不变，缓存后 ws 重连补发零开销。
let __cachedLine = null;

/**
 * 以 "key=value" 形式收集运行环境信息，用于诊断平台相关二进制依赖（如 pion-ipc）问题。
 *
 * 尽力而为：每项独立 try/catch，单项失败不影响其它项；无法获取时该字段省略。
 * 结果在进程生命周期内缓存，重复调用零额外开销。
 *
 * 字段：platform / arch / node / osrel / cpu / cores / mem
 *
 * @returns {string} - 形如 `platform=linux arch=x64 node=v20.11.0 osrel=6.6.87 cpu="Intel Xeon" cores=8 mem=16.0GB`
 */
export function getPlatformInfoLine() {
	if (__cachedLine !== null) return __cachedLine;
	const parts = [];

	tryPush(parts, 'platform', () => process.platform);
	tryPush(parts, 'arch', () => process.arch);
	tryPush(parts, 'node', () => process.version);
	tryPush(parts, 'osrel', () => os.release());
	tryPush(parts, 'cpu', () => {
		const model = os.cpus()?.[0]?.model;
		if (!model) return undefined;
		// 外层包双引号以保留含空格的 model；内部双引号 / C0 控制字符 / DEL 替换为空格后折叠空白
		const cleaned = String(model).replace(/["\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
		if (!cleaned) return undefined;
		return `"${cleaned}"`;
	});
	tryPush(parts, 'cores', () => {
		const n = os.cpus()?.length;
		return n > 0 ? n : undefined;
	});
	tryPush(parts, 'mem', () => {
		const bytes = os.totalmem();
		if (!bytes || !Number.isFinite(bytes)) return undefined;
		return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
	});

	__cachedLine = parts.join(' ');
	return __cachedLine;
}

/** 测试用：清缓存以便覆盖不同 monkey-patch 场景 */
export function __resetPlatformInfoCache() {
	__cachedLine = null;
}

function tryPush(parts, key, resolver) {
	try {
		const value = resolver();
		if (value === undefined || value === null || value === '') return;
		parts.push(`${key}=${value}`);
	} catch {
		// 单项失败静默跳过，不影响其它字段
	}
}
