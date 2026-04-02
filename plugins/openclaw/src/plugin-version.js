import fs from 'node:fs/promises';
import nodePath from 'node:path';

// 延迟读取 + 缓存：避免模块加载时 package.json 损坏导致插件整体无法注册
let __pluginVersion = null;
export async function getPluginVersion() {
	if (__pluginVersion) return __pluginVersion;
	try {
		const pkgPath = nodePath.resolve(import.meta.dirname, '..', 'package.json');
		const raw = await fs.readFile(pkgPath, 'utf8');
		__pluginVersion = JSON.parse(raw).version ?? 'unknown';
	} catch {
		return 'unknown';
	}
	return __pluginVersion;
}
// 测试用：重置缓存
export function __resetPluginVersion() { __pluginVersion = null; }
