import { createRequire } from 'module';
import nodePath from 'path';
import fsSync from 'fs';
import fsPromises from 'fs/promises';
import { remoteLog as defaultRemoteLog } from './remote-log.js';

const SUPPORTED_PLATFORMS = new Set([
	'linux-x64',
	'linux-arm64',
	'darwin-x64',
	'darwin-arm64',
	'win32-x64',
]);

/**
 * 解析 vendor 源和部署目标路径。
 * @param {string} platformKey - 如 'linux-x64'
 * @param {string} pluginRoot - 插件根目录
 * @returns {{ src: string, dest: string, destDir: string }}
 */
export function defaultResolvePaths(platformKey, pluginRoot) {
	const src = nodePath.join(pluginRoot, 'vendor', 'ndc-prebuilds', platformKey, 'node_datachannel.node');

	// 定位 node-datachannel 包根：从入口路径向上查找 package.json
	const require = createRequire(nodePath.join(pluginRoot, 'package.json'));
	const entryPath = require.resolve('node-datachannel');
	let pkgRoot = nodePath.dirname(entryPath);
	while (pkgRoot !== nodePath.dirname(pkgRoot)) {
		try {
			const pkg = JSON.parse(fsSync.readFileSync(nodePath.join(pkgRoot, 'package.json'), 'utf8'));
			if (pkg.name === 'node-datachannel') break;
		} catch { /* 继续向上 */ }
		pkgRoot = nodePath.dirname(pkgRoot);
	}
	const destDir = nodePath.join(pkgRoot, 'build', 'Release');
	const dest = nodePath.join(destDir, 'node_datachannel.node');

	return { src, dest, destDir };
}

/**
 * 预加载 node-datachannel，失败时回退到 werift。
 *
 * 所有异常内部捕获，仅通过 remoteLog 报告，不向外抛出。
 * 唯一可能抛出的情况：werift 回退也失败（不可恢复）。
 *
 * @param {object} [deps] - 可注入依赖（测试用）
 * @param {object} [deps.fs] - { access, copyFile, mkdir }
 * @param {Function} [deps.dynamicImport] - (specifier) => import(specifier)
 * @param {Function} [deps.remoteLog] - (text) => void
 * @param {string} [deps.platform] - 覆盖 process.platform
 * @param {string} [deps.arch] - 覆盖 process.arch
 * @param {string} [deps.pluginRoot] - 覆盖插件根目录
 * @param {Function} [deps.resolvePaths] - (platformKey, pluginRoot) => { src, dest, destDir }
 * @returns {Promise<{ PeerConnection: Function, cleanup: Function|null, impl: string }>}
 */
export async function preloadNdc(deps = {}) {
	const fs = deps.fs ?? fsPromises;
	const dynamicImport = deps.dynamicImport ?? ((spec) => import(spec));
	const log = deps.remoteLog ?? defaultRemoteLog;
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const pluginRoot = deps.pluginRoot ?? nodePath.resolve(import.meta.dirname, '..');
	const resolvePaths = deps.resolvePaths ?? defaultResolvePaths;

	const platformKey = `${platform}-${arch}`;
	log(`ndc.preload platform=${platformKey}`);

	try {
		// 平台检查
		if (!SUPPORTED_PLATFORMS.has(platformKey)) {
			log(`ndc.skip reason=unsupported-platform platform=${platformKey}`);
			return weriftFallback(dynamicImport, log);
		}
		const { src, dest, destDir } = resolvePaths(platformKey, pluginRoot);

		// 检查目标 binary 是否已存在（正常 pnpm install 或已执行过 bootstrap）
		let needCopy = false;
		try {
			await fs.access(dest);
			log('ndc.binary-exists');
		} catch {
			needCopy = true;
		}

		if (needCopy) {
			// 检查 vendor 源 binary
			try {
				await fs.access(src);
			} catch {
				log('ndc.fallback reason=binary-missing');
				return weriftFallback(dynamicImport, log);
			}

			// 部署 binary
			try {
				await fs.mkdir(destDir, { recursive: true });
				await fs.copyFile(src, dest);
				log('ndc.binary-deployed');
			} catch (err) {
				log(`ndc.fallback reason=copy-failed error=${err.message}`);
				return weriftFallback(dynamicImport, log);
			}
		}

		// 加载模块
		let polyfill, ndc;
		try {
			polyfill = await dynamicImport('node-datachannel/polyfill');
			ndc = await dynamicImport('node-datachannel');
		} catch (err) {
			log(`ndc.fallback reason=import-failed error=${err.message}`);
			return weriftFallback(dynamicImport, log);
		}

		const { RTCPeerConnection } = polyfill;
		const cleanup = ndc.cleanup ?? ndc.default?.cleanup ?? null;

		// 验证 RTCPeerConnection 可用（不创建实例，避免 native thread 阻止进程退出）
		if (typeof RTCPeerConnection !== 'function') {
			log('ndc.fallback reason=smoke-failed error=RTCPeerConnection is not a function');
			return weriftFallback(dynamicImport, log);
		}

		// 重要：调用方在不再需要 node-datachannel 时（如 bridge stop），必须调用 cleanup()。
		// node-datachannel 内部使用 ThreadSafeCallback 维持 native threads，不调用 cleanup()
		// 会阻止 Node 进程正常退出（上游 issue #366）。
		// 当前由 RealtimeBridge.stop() 负责调用。若 gateway 被 SIGKILL 强杀则无法执行，
		// 但 OS 会回收所有资源。若 OpenClaw 提供了优雅终止钩子，应在钩子中也调用 cleanup。
		log(`ndc.loaded platform=${platformKey}`);
		return { PeerConnection: RTCPeerConnection, cleanup, impl: 'ndc' };
	} catch (err) {
		// resolvePaths 或其他未预期异常的兜底
		log(`ndc.fallback reason=unexpected error=${err.message}`);
		return weriftFallback(dynamicImport, log);
	}
}

/**
 * 回退到 werift。
 * @param {Function} dynamicImport
 * @param {Function} log
 */
async function weriftFallback(dynamicImport, log) {
	const { RTCPeerConnection } = await dynamicImport('werift');
	log('ndc.using-werift');
	return { PeerConnection: RTCPeerConnection, cleanup: null, impl: 'werift' };
}
