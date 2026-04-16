/**
 * 导航/外链信任判定。
 *
 * 生产环境只信任远程业务域；开发环境额外信任本地 Vite 服务器。
 * 判定严格走 URL.origin 精确匹配，防止 subdomain 前缀绕过
 * （如 im.coclaw.net.evil.com）。
 */

export const REMOTE_URL = 'https://im.coclaw.net';
export const DEV_URL = 'http://localhost:5173';

/** 信任的导航来源（严格 origin 匹配） */
export const TRUSTED_ORIGINS = new Set([REMOTE_URL, DEV_URL]);

/**
 * 当前 URL 是否来自信任源
 * @param {string} urlStr - 任意 URL 字符串
 * @returns {boolean} 无效 URL 返回 false
 */
export function isTrustedUrl(urlStr) {
	try {
		return TRUSTED_ORIGINS.has(new URL(urlStr).origin);
	}
	catch {
		return false;
	}
}
