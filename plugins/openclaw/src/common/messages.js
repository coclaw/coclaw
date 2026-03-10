// bind/unbind CLI 及 command 的用户提示文案（统一出口）

export function bindOk({ botId, rebound, previousBotId }) {
	const action = rebound ? 're-bound' : 'bound';
	const prev = previousBotId
		? ` (previous binding to bot ${previousBotId} was auto-removed)`
		: '';
	return `OK. Bot (${botId}) ${action} to CoClaw.${prev}`;
}

export function unbindOk({ botId, serverError }) {
	const id = botId ?? 'unknown';
	const tag = serverError
		? ' (server notification failed; you can unbind the orphan bot in the CoClaw app)'
		: '';
	return `OK. Bot (${id}) unbound from CoClaw.${tag}`;
}

export function notBound() {
	return 'Not bound. Nothing to unbind.';
}

export function gatewayNotified(action) {
	return action === 'refresh'
		? 'Bridge connection refreshed.'
		: 'Bridge connection stopped.';
}

export function gatewayNotifyFailed() {
	return 'Note: could not notify the running gateway. If it is running, restart it manually.';
}
