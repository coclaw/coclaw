import { remoteLog as defaultRemoteLog } from '../remote-log.js';

const DEFAULT_START_TIMEOUT_MS = 10_000;

/**
 * 预加载 Pion WebRTC 实现：启动 pion-ipc Go 进程，返回绑定了 ipc 的 PeerConnection。
 *
 * **此函数永不 throw**——所有异常内部捕获，通过 remoteLog 报告。
 * 失败时返回 null（调用方降级到 ndc/werift）。
 *
 * binary 解析由 @coclaw/pion-node 内部处理（env → npm 平台包 → PATH）。
 *
 * @param {object} [deps] - 可注入依赖（测试用）
 * @param {Function} [deps.dynamicImport] - (specifier) => import(specifier)
 * @param {Function} [deps.remoteLog] - (text) => void
 * @param {number} [deps.startTimeout] - 启动超时（ms），默认 10s
 * @returns {Promise<{ PeerConnection: Function, cleanup: Function, impl: string, ipc: object }|null>}
 */
export async function preloadPion(deps = {}) {
	const log = deps.remoteLog ?? defaultRemoteLog;
	const dynamicImport = deps.dynamicImport ?? ((spec) => import(spec));
	const startTimeout = deps.startTimeout ?? DEFAULT_START_TIMEOUT_MS;

	log('pion.preload');

	let ipc = null;
	try {
		// 加载 pion-node SDK
		let PionIpc, RTCPeerConnection;
		try {
			const mod = await dynamicImport('@coclaw/pion-node');
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

		// 启动 IPC 进程（内部会 ping 验证就绪，binary 由 pion-node 自动解析）
		ipc = new PionIpc({
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
		// ipc 已启动但后续步骤意外失败 → 关闭 Go 进程，防止泄漏
		if (ipc) {
			ipc.stop().catch(() => {});
		}
		log(`pion.skip reason=unexpected error=${err.message}`);
		return null;
	}
}
