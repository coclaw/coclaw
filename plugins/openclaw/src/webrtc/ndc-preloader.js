import { createRequire } from 'module';
import nodePath from 'path';
import fsSync from 'fs';
import fsPromises from 'fs/promises';
import { remoteLog as defaultRemoteLog } from '../remote-log.js';

const SUPPORTED_PLATFORMS = new Set([
	'linux-x64',
	'linux-arm64',
	'darwin-x64',
	'darwin-arm64',
	'win32-x64',
]);

const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;

/**
 * 给 promise 加超时保护。超时后 reject，但原 promise 仍在后台执行——
 * JS 无法取消 pending 的 import()，超时只是让调用方不再等待。
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} label - 用于错误信息
 */
function withTimeout(promise, ms, label) {
	// 超时后原 promise 仍在后台执行（JS 无法取消 pending 的 import()）。
	// 必须 .catch 兜住原 promise 的潜在 rejection，否则超时场景下
	// 原 promise 最终 reject 会成为 unhandled rejection，导致进程终止。
	promise.catch(() => {});
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
 * ndc polyfill 的 RTCPeerConnection 将 iceServers 的 username:credential 直接拼入 URL，
 * 但 TURN REST API 的 username 格式为 `timestamp:identity`（含冒号），
 * 导致 libdatachannel 的 URL parser 截断 username。
 * 此 wrapper 在传入 polyfill 前对 username/credential 做 percent-encoding 规避该问题。
 */
function wrapNdcCredentials(NativeRTC) {
	return class extends NativeRTC {
		constructor(config = {}) {
			if (config?.iceServers) {
				config = {
					...config,
					iceServers: config.iceServers.map(s => {
						/* c8 ignore next -- TURN 无凭据时的短路，集成环境下不经过此路径 */
						if (!s.username && !s.credential) return s;
						return {
							...s,
							username: s.username ? encodeURIComponent(s.username) : s.username,
							credential: s.credential ? encodeURIComponent(s.credential) : s.credential,
						};
					}),
				};
			}
			super(config);
		}
	};
}

/**
 * 预加载 WebRTC 实现：优先 node-datachannel，失败回退 werift，全部失败返回 null。
 *
 * **此函数永不 throw**——所有异常内部捕获，通过 remoteLog 报告。
 * 返回值始终为 { PeerConnection, cleanup, impl } 结构。
 *
 * @param {object} [deps] - 可注入依赖（测试用）
 * @param {object} [deps.fs] - { access, copyFile, mkdir }
 * @param {Function} [deps.dynamicImport] - (specifier) => import(specifier)
 * @param {Function} [deps.remoteLog] - (text) => void
 * @param {string} [deps.platform] - 覆盖 process.platform
 * @param {string} [deps.arch] - 覆盖 process.arch
 * @param {string} [deps.pluginRoot] - 覆盖插件根目录
 * @param {Function} [deps.resolvePaths] - (platformKey, pluginRoot) => { src, dest, destDir }
 * @param {number} [deps.importTimeout] - 动态 import 超时（ms），默认 10s
 * @returns {Promise<{ PeerConnection: Function|null, cleanup: Function|null, impl: string }>}
 */
export async function preloadNdc(deps = {}) {
	const fs = deps.fs ?? fsPromises;
	const dynamicImport = deps.dynamicImport ?? ((spec) => import(spec));
	const log = deps.remoteLog ?? defaultRemoteLog;
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const pluginRoot = deps.pluginRoot ?? nodePath.resolve(import.meta.dirname, '../..');
	const resolvePaths = deps.resolvePaths ?? defaultResolvePaths;
	const importTimeout = deps.importTimeout ?? DEFAULT_IMPORT_TIMEOUT_MS;

	const platformKey = `${platform}-${arch}`;
	log(`ndc.preload platform=${platformKey}`);

	try {
		// 平台检查
		if (!SUPPORTED_PLATFORMS.has(platformKey)) {
			log(`ndc.skip reason=unsupported-platform platform=${platformKey}`);
			return weriftFallback(dynamicImport, log, importTimeout);
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
				return weriftFallback(dynamicImport, log, importTimeout);
			}

			// 部署 binary
			try {
				await fs.mkdir(destDir, { recursive: true });
				await fs.copyFile(src, dest);
				log('ndc.binary-deployed');
			} catch (err) {
				log(`ndc.fallback reason=copy-failed error=${err.message}`);
				return weriftFallback(dynamicImport, log, importTimeout);
			}
		}

		// 加载模块（带超时保护，防止 native binding dlopen 卡住）
		let polyfill, ndc;
		try {
			polyfill = await withTimeout(
				dynamicImport('node-datachannel/polyfill'),
				importTimeout,
				'import(node-datachannel/polyfill)',
			);
			ndc = await withTimeout(
				dynamicImport('node-datachannel'),
				importTimeout,
				'import(node-datachannel)',
			);
		} catch (err) {
			log(`ndc.fallback reason=import-failed error=${err.message}`);
			return weriftFallback(dynamicImport, log, importTimeout);
		}

		const { RTCPeerConnection } = polyfill;
		const cleanup = ndc.cleanup ?? ndc.default?.cleanup ?? null;

		// 验证 RTCPeerConnection 可用（不创建实例，避免 native thread 阻止进程退出）
		if (typeof RTCPeerConnection !== 'function') {
			log('ndc.fallback reason=smoke-failed error=RTCPeerConnection is not a function');
			return weriftFallback(dynamicImport, log, importTimeout);
		}

		// 注册 libdatachannel 内部日志回调（Warning 级别），
		// 用于捕获 ICE/DTLS/SCTP 层断连原因。
		// initLogger 是进程全局单例，调用一次即可（cleanup 不会被调用，logger 全程有效）。
		// callback 通过 TSFN 投递到 JS 主线程，Warning 级别正常运行时零输出。
		/* c8 ignore next -- ??/?. fallback */
		const initLogger = ndc.initLogger ?? ndc.default?.initLogger;
		if (typeof initLogger === 'function') {
			try {
				initLogger('Warning', (level, message) => {
					try {
						const msg = typeof message === 'string' ? message.replace(/\n/g, '\\n') : message;
						log(`ndc.native level=${level} ${msg}`);
					} catch { /* 不让任何异常传播到 native 层 */ }
				});
				log('ndc.logger-registered level=Warning');
			} catch (err) {
				// initLogger 失败不影响 ndc 正常使用
				log(`ndc.logger-failed error=${err.message}`);
			}
		}

		// 重要：调用方在不再需要 node-datachannel 时（如 bridge stop），必须调用 cleanup()。
		// node-datachannel 内部使用 ThreadSafeCallback 维持 native threads，不调用 cleanup()
		// 会阻止 Node 进程正常退出（上游 issue #366）。
		// 当前 RealtimeBridge.stop() 不调用 cleanup()（阻塞 10s+），native threads 保持活跃供复用。
		// 进程退出时 OS 会回收所有资源。
		log(`ndc.loaded platform=${platformKey}`);
		return { PeerConnection: wrapNdcCredentials(RTCPeerConnection), cleanup, impl: 'ndc' };
	} catch (err) {
		// resolvePaths 或其他未预期异常的兜底
		log(`ndc.fallback reason=unexpected error=${err.message}`);
		return weriftFallback(dynamicImport, log, importTimeout);
	}
}

/**
 * 回退到 werift。加载也带超时保护。
 * werift 也失败时返回 PeerConnection: null（WebRTC 不可用但不影响 gateway）。
 * @param {Function} dynamicImport
 * @param {Function} log
 * @param {number} importTimeout
 */
async function weriftFallback(dynamicImport, log, importTimeout) {
	try {
		const { RTCPeerConnection } = await withTimeout(
			dynamicImport('werift'),
			importTimeout,
			'import(werift)',
		);
		log('webrtc.fallback-to-werift');
		return { PeerConnection: RTCPeerConnection, cleanup: null, impl: 'werift' };
	} catch (err) {
		log(`webrtc.all-unavailable error=${err.message}`);
		return { PeerConnection: null, cleanup: null, impl: 'none' };
	}
}
