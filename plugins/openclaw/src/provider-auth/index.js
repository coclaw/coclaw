/**
 * provider-auth 注册入口 —— 把 handler 接到 gateway。
 * （coclaw.providerAuth.setApiKey / list / remove / loginOauth / cancelOauth）
 *
 * 设计：
 * - SDK 通过**懒加载 dynamic import** 拿，避免本模块在测试环境（无 openclaw npm 包）下
 *   一加载就崩。第一次 RPC 调用时才解析；后续调用复用缓存的 promise
 * - OAuth 额外需要 `mutateConfigFile`（config-mutation 子入口）写 provider 节点 baseUrl；
 *   PKCE / 表单编码器从 provider-auth 子入口拿（同一 barrel 已导出）
 * - `mainAgentDir` 走 claw-paths.js 统一入口，handler 每次调用都现拿（state-dir 由 runtime 决定）
 * - `opts` 主要给单测用：可注入 fake sdk / agentDir resolver / loader
 *
 * 生产路径上 loadSdk / loadConfigMutation 必须由入口（plugins/openclaw/index.js）注入字面量
 * dynamic import —— OpenClaw plugin loader 只扫入口源码识别 `openclaw/plugin-sdk/*` 字面量并
 * 触发 jiti 重写；藏在本子模块的字面量 loader 看不到 → 原生 Node 解析必败。
 */
import { buildProviderAuthHandlers } from './handlers.js';
import { createMiniMaxOAuth } from './minimax-oauth.js';
import { registerLogin, getLogin, removeLogin } from './oauth-registry.js';
import { mainAgentDir } from '../claw-paths.js';

// link-UNSAFE：模块级 dedup 缓存。`--link` 模式下两实例各自 lazy-load 一次
// SDK（结果一致、运行无伤但去重失效）。当前仅 RPC handler 走该路径——
// 不要在 hook 回调里访问本模块的 export。详见 docs/module-boundaries.md。
let _sdkPromise;
let _configMutationPromise;
let _catalogRuntimePromise;
let _agentRuntimePromise;

// 默认 loader 仅作 fallback：生产路径必须由入口（plugins/openclaw/index.js）注入，
// 因为 OpenClaw plugin loader 只扫入口源码识别 `openclaw/plugin-sdk/*` 字面量并触发 jiti 重写；
// 字面量留在本子模块里 loader 看不到 → 原生 Node 解析必败。
// 此处的 import 在生产环境永不被调用；保留只为测试在不注入 opts.load* 时仍能拿到一个失败路径
function defaultLoadSdk() {
	_sdkPromise ??= import('openclaw/plugin-sdk/provider-auth');
	return _sdkPromise;
}

function defaultLoadConfigMutation() {
	_configMutationPromise ??= import('openclaw/plugin-sdk/config-mutation');
	return _configMutationPromise;
}

function defaultLoadProviderCatalogRuntime() {
	_catalogRuntimePromise ??= import('openclaw/plugin-sdk/provider-catalog-runtime');
	return _catalogRuntimePromise;
}

function defaultLoadAgentRuntime() {
	// agent-runtime barrel 提供 resolveProviderIdForAuth（别名归一基座 id）——catalog 算 hasCred 用。
	_agentRuntimePromise ??= import('openclaw/plugin-sdk/agent-runtime');
	return _agentRuntimePromise;
}

/**
 * 测试辅助：清掉懒加载 SDK 缓存。
 */
export function __resetSdkCache() {
	_sdkPromise = undefined;
	_configMutationPromise = undefined;
	_catalogRuntimePromise = undefined;
	_agentRuntimePromise = undefined;
}

/**
 * 在 gateway api 上注册 `coclaw.providerAuth.*`。
 *
 * 仅 `register(api)` 的 `if (api.registrationMode === 'full')` 分支调；
 * 其它 mode 注册副作用违规（参 plugins/openclaw/CLAUDE.md "Service / register 副作用边界"）。
 *
 * @param {object} api - OpenClaw 注入的 plugin api
 * @param {object} [opts]
 * @param {Function} [opts.resolveAgentDir] - 覆盖 agentDir 解析（默认 mainAgentDir）
 * @param {Function} [opts.loadSdk] - 必传（生产由入口注入字面量 dynamic import）；缺省回退仅为测试兜底
 * @param {Function} [opts.loadConfigMutation] - 必传（同上，OAuth 写 cfg 用）
 * @param {Function} [opts.loadProviderCatalogRuntime] - 必传（同上，通用 device-code 登录 B1 + catalog setup 全集拿 resolvePluginProviders 用）
 * @param {Function} [opts.loadAgentRuntime] - 必传（同上，catalog 算 hasCred 拿 resolveProviderIdForAuth 用）
 * @param {object} [opts.registry] - 覆盖 oauth-registry（默认模块级单例）
 */
export function registerProviderAuthHandlers(api, opts = {}) {
	const resolveAgentDir = opts.resolveAgentDir ?? mainAgentDir;
	const loadSdk = opts.loadSdk ?? defaultLoadSdk;
	const loadConfigMutation = opts.loadConfigMutation ?? defaultLoadConfigMutation;
	const loadProviderCatalogRuntime = opts.loadProviderCatalogRuntime ?? defaultLoadProviderCatalogRuntime;
	const loadAgentRuntime = opts.loadAgentRuntime ?? defaultLoadAgentRuntime;
	const registry = opts.registry ?? { registerLogin, getLogin, removeLogin };

	// catalog-runtime 仅通用 device-code 登录（B1）与 catalog 才需要，独立惰性加载——不耦合进 getHandlers
	// 的 Promise.all，避免 setApiKey / list / remove / minimax-oauth 因这个 SDK 子入口缺失而连带失败。
	let catalogRuntimePromise;
	const resolveProviders = async ({ config, providerRefs }) => {
		catalogRuntimePromise ??= loadProviderCatalogRuntime();
		const catalogRuntime = await catalogRuntimePromise;
		// 铁律：activate:false —— 只读拿 method.run，不激活 provider，零副作用（不动 gateway 活跃插件名册）。
		return catalogRuntime.resolvePluginProviders({
			config,
			providerRefs,
			activate: false,
			mode: 'runtime',
		});
	};
	// catalog 用的 setup 全集解析（独立于上面的 runtime 闭包——B1 登录仍走 runtime）：
	// mode:'setup' 无条件返回全部 provider（含未配过的），activate:false 零副作用、cache:true 复用发现缓存。
	const resolveSetupProviders = async ({ config }) => {
		catalogRuntimePromise ??= loadProviderCatalogRuntime();
		const catalogRuntime = await catalogRuntimePromise;
		return catalogRuntime.resolvePluginProviders({
			config,
			activate: false,
			cache: true,
			mode: 'setup',
		});
	};
	// agent-runtime 同样独立惰性加载（仅 catalog 的 hasCred 别名归一才需要），不耦合进 getHandlers。
	let agentRuntimePromise;
	const loadProviderIdResolver = async () => {
		agentRuntimePromise ??= loadAgentRuntime();
		const agentRuntime = await agentRuntimePromise;
		return agentRuntime.resolveProviderIdForAuth;
	};

	let handlersPromise;
	async function getHandlers() {
		if (!handlersPromise) {
			handlersPromise = (async () => {
				const [providerAuthSdk, configMutation] = await Promise.all([
					loadSdk(),
					loadConfigMutation(),
				]);
				const sdk = {
					...providerAuthSdk,
					mutateConfigFile: configMutation.mutateConfigFile,
				};
				// PKCE / 表单编码器从 provider-auth barrel 取，注入给设备码流原语
				const oauth = createMiniMaxOAuth({
					generatePkce: providerAuthSdk.generatePkceVerifierChallenge,
					toForm: providerAuthSdk.toFormUrlEncoded,
				});
				return buildProviderAuthHandlers({
					sdk,
					resolveAgentDir,
					oauth,
					registry,
					resolveProviders,
					resolveSetupProviders,
					loadProviderIdResolver,
				});
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
	api.registerGatewayMethod('coclaw.providerAuth.loginOauth', wrap('loginOauth'));
	api.registerGatewayMethod('coclaw.providerAuth.cancelOauth', wrap('cancelOauth'));
	api.registerGatewayMethod('coclaw.providerAuth.catalog', wrap('catalog'));
}
