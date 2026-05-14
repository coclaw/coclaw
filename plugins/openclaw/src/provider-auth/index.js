/**
 * provider-auth 注册入口 —— 把三个 handler 接到 gateway。
 *
 * 设计：
 * - SDK 通过**懒加载 dynamic import** 拿，避免本模块在测试环境（无 openclaw npm 包）下
 *   一加载就崩。第一次 RPC 调用时才解析；后续调用复用缓存的 promise
 * - `mainAgentDir` 走 claw-paths.js 统一入口，handler 每次调用都现拿（state-dir 由 runtime 决定）
 * - `opts` 主要给单测用：可注入 fake sdk / agentDir resolver / loader
 */
import { buildProviderAuthHandlers } from './handlers.js';
import { mainAgentDir } from '../claw-paths.js';

let _sdkPromise;

// 默认 loader 仅作 fallback：生产路径必须由入口（plugins/openclaw/index.js）注入 loadSdk，
// 因为 OpenClaw plugin loader 只扫入口源码识别 `openclaw/plugin-sdk/*` 字面量并触发 jiti 重写；
// 字面量留在本子模块里 loader 看不到 → 原生 Node 解析必败。
// 此处的 import 在生产环境永不被调用；保留只为测试在不注入 opts.loadSdk 时仍能拿到一个失败路径
function defaultLoadSdk() {
	_sdkPromise ??= import('openclaw/plugin-sdk/provider-auth');
	return _sdkPromise;
}

/**
 * 测试辅助：清掉懒加载 SDK 缓存。
 */
export function __resetSdkCache() {
	_sdkPromise = undefined;
}

/**
 * 在 gateway api 上注册 `coclaw.providerAuth.setApiKey` / `list` / `remove`。
 *
 * 仅 `register(api)` 的 `if (api.registrationMode === 'full')` 分支调；
 * 其它 mode 注册副作用违规（参 plugins/openclaw/CLAUDE.md "Service / register 副作用边界"）。
 *
 * @param {object} api - OpenClaw 注入的 plugin api
 * @param {object} [opts]
 * @param {Function} [opts.resolveAgentDir] - 覆盖 agentDir 解析（默认 mainAgentDir）
 * @param {Function} [opts.loadSdk] - 必传（生产由入口注入字面量 dynamic import）；缺省回退仅为测试兜底
 */
export function registerProviderAuthHandlers(api, opts = {}) {
	const resolveAgentDir = opts.resolveAgentDir ?? mainAgentDir;
	const loadSdk = opts.loadSdk ?? defaultLoadSdk;

	let handlersPromise;
	async function getHandlers() {
		if (!handlersPromise) {
			handlersPromise = (async () => {
				const sdk = await loadSdk();
				return buildProviderAuthHandlers({ sdk, resolveAgentDir });
			})();
		}
		return handlersPromise;
	}

	function wrap(methodName) {
		return async (ctx) => {
			let handlers;
			try {
				handlers = await getHandlers();
			}
			catch (err) {
				// SDK 加载失败：硬编码 IO_FAILED（doc 契约只承诺这两种 code），仍透 message 供诊断
				ctx.respond(false, undefined, {
					code: 'IO_FAILED',
					message: String(err?.message ?? err),
				});
				return;
			}
			await handlers[methodName](ctx);
		};
	}

	api.registerGatewayMethod('coclaw.providerAuth.setApiKey', wrap('setApiKey'));
	api.registerGatewayMethod('coclaw.providerAuth.list', wrap('list'));
	api.registerGatewayMethod('coclaw.providerAuth.remove', wrap('remove'));
}
