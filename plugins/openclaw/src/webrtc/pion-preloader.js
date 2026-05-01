import { remoteLog as defaultRemoteLog } from '../remote-log.js';

const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 20_000;

// 匹配 pion-node 内部视为严重的 log：IPC 请求超时、以及 Go 侧迟到的响应（主请求已 reject，响应变孤儿）
const SEVERE_LOG_PATTERN = /request timeout|orphan response/;

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
 * @param {object} [deps.logger] - plugin 本地 pino-style logger（.info/.warn/.error），用于本地调试可见性
 * @param {number} [deps.ipcRequestTimeout] - 每次 IPC 请求的超时（ms，也用于启动 ping），默认 20s
 * @returns {Promise<{ PeerConnection: Function, cleanup: Function, impl: string, ipc: object }|null>}
 */
export async function preloadPion(deps = {}) {
	const log = deps.remoteLog ?? defaultRemoteLog;
	const localLogger = deps.logger ?? null;
	const dynamicImport = deps.dynamicImport ?? ((spec) => import(spec));
	const ipcRequestTimeout = deps.ipcRequestTimeout ?? DEFAULT_IPC_REQUEST_TIMEOUT_MS;

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
		// logger 回调双打：始终走 remoteLog；同时送本地 logger，严重事件（IPC 超时、orphan 响应）
		// 升级到 error 级别，便于本地调试时一眼可见；其他运维类消息走 info。
		// pion-node SDK 已在 msg 中加 [pion-ipc] 前缀，此处不再重复
		ipc = new PionIpc({
			logger: (msg) => {
				log(`pion.ipc ${msg}`);
				if (SEVERE_LOG_PATTERN.test(msg)) {
					localLogger?.error?.(msg);
				} else {
					localLogger?.info?.(msg);
				}
			},
			timeout: ipcRequestTimeout,
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
