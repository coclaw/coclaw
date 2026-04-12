import nodePath from 'path';
import { existsSync } from 'fs';
import { remoteLog as defaultRemoteLog } from '../remote-log.js';

const DEFAULT_START_TIMEOUT_MS = 10_000;

/**
 * 预加载 Pion WebRTC 实现：启动 pion-ipc Go 进程，返回绑定了 ipc 的 PeerConnection。
 *
 * **此函数永不 throw**——所有异常内部捕获，通过 remoteLog 报告。
 * 失败时返回 null（调用方降级到 ndc/werift）。
 *
 * @param {object} [deps] - 可注入依赖（测试用）
 * @param {Function} [deps.dynamicImport] - (specifier) => import(specifier)
 * @param {Function} [deps.remoteLog] - (text) => void
 * @param {string} [deps.pluginRoot] - 覆盖插件根目录
 * @param {string} [deps.binPath] - 覆盖 binary 路径
 * @param {number} [deps.startTimeout] - 启动超时（ms），默认 10s
 * @returns {Promise<{ PeerConnection: Function, cleanup: Function, impl: string, ipc: object }|null>}
 */
export async function preloadPion(deps = {}) {
	const log = deps.remoteLog ?? defaultRemoteLog;
	const dynamicImport = deps.dynamicImport ?? ((spec) => import(spec));
	const pluginRoot = deps.pluginRoot ?? nodePath.resolve(import.meta.dirname, '../..');
	const startTimeout = deps.startTimeout ?? DEFAULT_START_TIMEOUT_MS;

	log('pion.preload');

	try {
		// 解析 binary 路径
		const binPath = deps.binPath ?? resolvePionBinary(pluginRoot);
		if (!binPath) {
			log('pion.skip reason=binary-not-found');
			return null;
		}

		// 加载 pion-node SDK
		let PionIpc, RTCPeerConnection;
		try {
			const mod = await dynamicImport('pion-node');
			PionIpc = mod.PionIpc;
			RTCPeerConnection = mod.RTCPeerConnection;
		} catch (err) {
			log(`pion.skip reason=import-failed error=${err.message}`);
			return null;
		}

		if (typeof PionIpc !== 'function' || typeof RTCPeerConnection !== 'function') {
			log('pion.skip reason=invalid-exports');
			return null;
		}

		// 启动 IPC 进程（内部会 ping 验证就绪）
		const ipc = new PionIpc({
			binPath,
			logger: (msg) => log(`pion.ipc ${msg}`),
			timeout: startTimeout,
			autoRestart: true,
		});

		try {
			await ipc.start();
		} catch (err) {
			log(`pion.skip reason=start-failed error=${err.message}`);
			return null;
		}

		// 创建绑定了 ipc 的 PeerConnection 子类
		// WebRtcPeer 使用 new PeerConnection({ iceServers }) 创建，无需感知 _ipc
		class BoundPeerConnection extends RTCPeerConnection {
			constructor(config = {}) {
				super({ ...config, _ipc: ipc });
			}
		}

		const cleanup = async () => {
			try {
				await ipc.stop();
			} catch {
				// 静默忽略，stop 失败不影响后续
			}
		};

		log('pion.loaded');
		return { PeerConnection: BoundPeerConnection, cleanup, impl: 'pion', ipc };
	} catch (err) {
		log(`pion.skip reason=unexpected error=${err.message}`);
		return null;
	}
}

/**
 * 解析 pion-ipc binary 路径。
 * 优先级：1) PION_IPC_BIN 环境变量  2) vendor/pion-ipc/pion-ipc
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function resolvePionBinary(pluginRoot) {
	// 1. 环境变量
	const envBin = process.env.PION_IPC_BIN;
	if (envBin) {
		if (existsSync(envBin)) return envBin;
		return null;
	}

	// 2. vendor 目录
	const isWin = process.platform === 'win32';
	const binName = isWin ? 'pion-ipc.exe' : 'pion-ipc';
	const vendorBin = nodePath.join(pluginRoot, 'vendor', 'pion-ipc', binName);
	if (existsSync(vendorBin)) return vendorBin;

	return null;
}
