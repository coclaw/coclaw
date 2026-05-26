/**
 * oauth-registry.js —— 进行中的 OAuth 登录的模块级登记表
 *
 * `loginOauth` 启动后台轮询时把 loginId → { abortController } 登记进来；
 * `cancelOauth` 按 loginId 查到后 abort()；轮询循环终态时自行移除。
 *
 * link-safety：登录登记 / 取消 / 移除都只在 RPC handler 路径触发（由同一次
 * registerProviderAuthHandlers 注册的 loginOauth + cancelOauth 共享同一模块实例），
 * 不被任何 hook 回调访问——所以这个模块级单例对本用法是安全的。
 * 详见 docs/module-boundaries.md 的双实例陷阱说明（hook ↔ RPC 才会分叉）。
 */

const __registry = new Map();

/**
 * 登记一个进行中的登录。
 * @param {string} loginId
 * @param {{ abortController: AbortController }} entry
 */
export function registerLogin(loginId, entry) {
	__registry.set(loginId, entry);
}

/**
 * 查登记项；未知 loginId 返回 undefined。
 * @param {string} loginId
 * @returns {{ abortController: AbortController } | undefined}
 */
export function getLogin(loginId) {
	return __registry.get(loginId);
}

/**
 * 移除登记项（终态清理）。
 * @param {string} loginId
 */
export function removeLogin(loginId) {
	__registry.delete(loginId);
}

/**
 * 测试辅助：清空登记表。
 */
export function __resetRegistry() {
	__registry.clear();
}
