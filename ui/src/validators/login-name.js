// loginName 格式校验（与 server 端同规则）

const MIN_LEN = 3;
const MAX_LEN = 28;

// 首尾必须是字母或数字；中间允许字母、数字、下划线、连字符、点；禁止连续特殊字符
const FORMAT_RE = /^(?!.*[_.\-]{2})[a-zA-Z0-9][a-zA-Z0-9_.\-]{1,26}[a-zA-Z0-9]$/;

const RESERVED_NAMES = new Set([
	'admin', 'administrator', 'root', 'system', 'superuser',
	'api', 'www', 'mail', 'ftp', 'ssh', 'smtp', 'pop', 'imap',
	'support', 'help', 'info', 'contact', 'feedback',
	'coclaw', 'openclaw',
	'login', 'logout', 'register', 'signup', 'signin', 'signout', 'auth', 'oauth',
	'null', 'undefined', 'true', 'false',
	'test', 'demo', 'guest', 'bot', 'anonymous',
	'moderator', 'mod', 'operator', 'webmaster', 'postmaster', 'hostmaster', 'abuse',
	'noreply', 'no-reply', 'security', 'billing', 'account', 'accounts', 'dashboard',
	'config', 'settings', 'status', 'health', 'ping',
]);

/**
 * 校验 loginName 格式
 * @param {string} loginName
 * @returns {{ valid: boolean, code?: string }}
 */
export function validateLoginName(loginName) {
	if (typeof loginName !== 'string') {
		return { valid: false, code: 'INVALID_INPUT' };
	}

	const len = loginName.length;
	if (len < MIN_LEN || len > MAX_LEN) {
		return { valid: false, code: 'LOGIN_NAME_LENGTH' };
	}

	if (!FORMAT_RE.test(loginName)) {
		return { valid: false, code: 'LOGIN_NAME_FORMAT' };
	}

	if (RESERVED_NAMES.has(loginName.toLowerCase())) {
		return { valid: false, code: 'LOGIN_NAME_RESERVED' };
	}

	return { valid: true };
}

export { RESERVED_NAMES, MIN_LEN, MAX_LEN, FORMAT_RE };
