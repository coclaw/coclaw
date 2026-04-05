// loginName 格式校验

const MIN_LEN = 3;
const MAX_LEN = 28;

// 首尾必须是字母或数字；中间允许字母、数字、下划线、连字符、点；禁止连续特殊字符
const FORMAT_RE = /^(?!.*[_.\-]{2})[a-zA-Z0-9][a-zA-Z0-9_.\-]{1,26}[a-zA-Z0-9]$/;

const RESERVED_NAMES = new Set([
	// 系统角色
	'admin', 'administrator', 'root', 'system', 'superuser',
	// 网络服务
	'api', 'www', 'mail', 'ftp', 'ssh', 'smtp', 'pop', 'imap',
	// 客服/运营
	'support', 'help', 'info', 'contact', 'feedback',
	// 品牌
	'coclaw', 'openclaw',
	// 认证相关
	'login', 'logout', 'register', 'signup', 'signin', 'signout', 'auth', 'oauth',
	// 编程保留字
	'null', 'undefined', 'true', 'false',
	// 特殊身份
	'test', 'demo', 'guest', 'bot', 'claw', 'anonymous',
	// 管理/运维
	'moderator', 'mod', 'operator', 'webmaster', 'postmaster', 'hostmaster', 'abuse',
	// 邮箱/系统
	'noreply', 'no-reply', 'security', 'billing', 'account', 'accounts', 'dashboard',
	// 系统路径
	'config', 'settings', 'status', 'health', 'ping',
]);

/**
 * 校验 loginName 格式
 * @param {string} loginName
 * @returns {{ valid: boolean, code?: string, message?: string }}
 */
export function validateLoginName(loginName) {
	if (typeof loginName !== 'string') {
		return fail('INVALID_INPUT', 'loginName must be a string');
	}

	const len = loginName.length;
	if (len < MIN_LEN || len > MAX_LEN) {
		return fail(
			'LOGIN_NAME_LENGTH',
			`loginName must be ${MIN_LEN}-${MAX_LEN} characters`,
		);
	}

	if (!FORMAT_RE.test(loginName)) {
		return fail(
			'LOGIN_NAME_FORMAT',
			'loginName may only contain letters, digits, underscores, hyphens, and dots; '
			+ 'must start and end with a letter or digit; '
			+ 'no consecutive special characters',
		);
	}

	if (RESERVED_NAMES.has(loginName.toLowerCase())) {
		return fail('LOGIN_NAME_RESERVED', 'This login name is reserved');
	}

	return { valid: true };
}

function fail(code, message) {
	return { valid: false, code, message };
}

export { RESERVED_NAMES, MIN_LEN, MAX_LEN, FORMAT_RE };
