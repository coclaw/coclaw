/**
 * model-default 注册入口 —— 把 coclaw.model.set / list / listAvailable 接到 gateway
 *（listAvailable 即原 listUsable 改名；listUsable 作过渡别名继续注册、映到同一 handler）。
 *
 * 设计（同 provider-auth/index.js）：
 * - 三个 SDK 子入口（config-mutation / provider-auth / agent-runtime）懒加载，
 *   首次 RPC 调用才解析；失败硬编码 IO_FAILED 透 message
 * - mainAgentDir 走 claw-paths.js；loadConfig 走 claw-config.js
 * - opts 主要给单测用：可注入 fake sdk 工厂 / fake agentDir resolver / fake loadConfig
 *
 * 生产路径上 loadXxx 必须由入口（plugins/openclaw/index.js）显式注入字面量
 * dynamic import —— 因 OpenClaw plugin loader 只扫入口源码识别
 * `openclaw/plugin-sdk/*` 字面量并触发 jiti 重写；本子模块里的 import 字面量 loader
 * 看不到 → 原生 Node 解析必败（详见 provider-auth/index.js 同款说明）。
 */

import { buildModelDefaultHandlers } from './handlers.js';
import { mainAgentDir } from '../claw-paths.js';
import { getClawConfig } from '../claw-config.js';

// link-UNSAFE：模块级 dedup 缓存。`--link` 模式下两实例各自 lazy-load 一次
// SDK（结果一致、运行无伤但去重失效）。当前仅 RPC handler 走该路径——
// 不要在 hook 回调里访问本模块的 export。详见 docs/module-boundaries.md。
let _configMutationP;
let _providerAuthP;
let _agentRuntimeP;

function defaultLoadConfigMutation() {
	_configMutationP ??= import('openclaw/plugin-sdk/config-mutation');
	return _configMutationP;
}
function defaultLoadProviderAuth() {
	_providerAuthP ??= import('openclaw/plugin-sdk/provider-auth');
	return _providerAuthP;
}
function defaultLoadAgentRuntime() {
	// agent-runtime barrel 同时给：resolveProviderIdForAuth（别名归一）+ loadModelCatalog（干净目录，
	// set 存在性 / listAvailable 选模型器枚举同源）。barrel re-export provider-auth-aliases.js + model-catalog.js。
	_agentRuntimeP ??= import('openclaw/plugin-sdk/agent-runtime');
	return _agentRuntimeP;
}

/**
 * 测试辅助：清掉懒加载 SDK 缓存。
 */
export function __resetSdkCaches() {
	_configMutationP = undefined;
	_providerAuthP = undefined;
	_agentRuntimeP = undefined;
}

/**
 * 在 gateway api 上注册 `coclaw.model.set` / `coclaw.model.list` / `coclaw.model.listAvailable`
 *（外加过渡别名 `coclaw.model.listUsable`，与 listAvailable 映同一 handler）。
 *
 * 仅 `register(api)` 的 `if (api.registrationMode === 'full')` 分支调；
 * 其它 mode 注册副作用违规（参 plugins/openclaw/CLAUDE.md "Service / register 副作用边界"）。
 *
 * @param {object} api - OpenClaw 注入的 plugin api
 * @param {object} [opts]
 * @param {Function} [opts.resolveAgentDir] - 覆盖 agentDir 解析（默认 mainAgentDir）
 * @param {Function} [opts.loadConfig] - 覆盖 cfg 读取（默认 getClawConfig）
 * @param {Function} [opts.loadConfigMutation] - 必传（生产由入口注入字面量 dynamic import）
 * @param {Function} [opts.loadProviderAuth] - 必传（同上）
 * @param {Function} [opts.loadAgentRuntime] - 必传（同上；resolveProviderIdForAuth + loadModelCatalog）
 */
export function registerModelDefaultHandlers(api, opts = {}) {
	const resolveAgentDir = opts.resolveAgentDir ?? mainAgentDir;
	const loadConfig = opts.loadConfig ?? getClawConfig;
	const loadConfigMutation = opts.loadConfigMutation ?? defaultLoadConfigMutation;
	const loadProviderAuth = opts.loadProviderAuth ?? defaultLoadProviderAuth;
	const loadAgentRuntime = opts.loadAgentRuntime ?? defaultLoadAgentRuntime;

	let handlersPromise;
	async function getHandlers() {
		if (!handlersPromise) {
			handlersPromise = (async () => {
				const [configMutation, providerAuth, agentRuntime] = await Promise.all([
					loadConfigMutation(),
					loadProviderAuth(),
					loadAgentRuntime(),
				]);
				const sdk = {
					mutateConfigFile: configMutation.mutateConfigFile,
					// 干净目录（set 存在性 + listAvailable 枚举同源）：agent-runtime barrel re-export model-catalog.js
					loadModelCatalog: agentRuntime.loadModelCatalog,
					// 凭据信号（providerUsable / hasAnyUsableCredential / 凭据门）
					isProviderApiKeyConfigured: providerAuth.isProviderApiKeyConfigured,
					hasConfiguredSecretInput: providerAuth.hasConfiguredSecretInput,
					ensureAuthProfileStore: providerAuth.ensureAuthProfileStore,
					// 别名归一（内联凭据信号 + 选模型器枚举）
					resolveProviderIdForAuth: agentRuntime.resolveProviderIdForAuth,
				};
				return buildModelDefaultHandlers({ sdk, loadConfig, resolveAgentDir });
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
				ctx.respond(false, undefined, {
					code: 'IO_FAILED',
					message: String(err?.message ?? err),
				});
				return;
			}
			await handlers[methodName](ctx);
		};
	}

	api.registerGatewayMethod('coclaw.model.set', wrap('set'));
	api.registerGatewayMethod('coclaw.model.list', wrap('list'));
	api.registerGatewayMethod('coclaw.model.listAvailable', wrap('listAvailable'));
	// 过渡别名：旧 UI 仍调 listUsable，映到同一 handler（决策1：纯过渡，不加任何额外兜底）
	api.registerGatewayMethod('coclaw.model.listUsable', wrap('listAvailable'));
}
