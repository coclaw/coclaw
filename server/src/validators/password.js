// 密码格式校验

export const MIN_PASSWORD_LENGTH = 8;

/**
 * 校验密码格式
 * @param {string} password
 * @returns {{ valid: boolean, code?: string, message?: string }}
 */
export function validatePassword(password) {
	if (typeof password !== 'string' || password.trim() === '') {
		return {
			valid: false,
			code: 'INVALID_INPUT',
			message: 'password is required',
		};
	}

	if (password.length < MIN_PASSWORD_LENGTH) {
		return {
			valid: false,
			code: 'PASSWORD_TOO_SHORT',
			message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
		};
	}

	return { valid: true };
}
