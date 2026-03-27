/**
 * 判断 URL 是否允许通过 shell.openExternal 打开
 * 仅允许 http/https 协议，拦截 file://、javascript: 等
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeExternalUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}
