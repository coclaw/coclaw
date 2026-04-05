const ERROR_TEXT_MAP = {
	INVALID_INPUT: 'Invalid input',
	BINDING_CODE_INVALID: 'Binding code is invalid',
	BINDING_CODE_EXPIRED: 'Binding code has expired, please get a new one',
	BINDING_CODE_EXHAUSTED: 'Server cannot generate binding code right now, please try again later',
	CLAW_BLOCKED: 'Claw is blocked, please contact the admin',
	UNAUTHORIZED: 'Auth failed, please check token or re-bind',
	INTERNAL_SERVER_ERROR: 'Server error, please try again later',
};

export function resolveErrorMessage(err, fallback = '请求失败') {
	const code = err?.response?.data?.code;
	if (code && ERROR_TEXT_MAP[code]) {
		return `${ERROR_TEXT_MAP[code]} (${code})`;
	}
	if (err?.response?.data?.message) {
		return `${err.response.data.message}${code ? ` (${code})` : ''}`;
	}
	if (err?.message) {
		return err.message;
	}
	return fallback;
}
