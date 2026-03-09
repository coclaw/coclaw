// bind/unbind CLI 及 command 的用户提示文案（统一出口）

export function bindOk({ botId, rebound }) {
	const action = rebound ? 're-bound' : 'bound';
	return `OK. Bot (${botId}) ${action} to CoClaw.`;
}

export function unbindOk({ botId, serverError }) {
	const id = botId ?? 'unknown';
	const tag = serverError
		? ' (server notification failed; you can unbind the orphan bot in the CoClaw app)'
		: '';
	return `OK. Bot (${id}) unbound from CoClaw.${tag}`;
}

export function alreadyBound({ botId }) {
	const id = botId ?? 'unknown';
	return `Already bound to CoClaw as bot (${id}).\nRun \`openclaw coclaw unbind\` to unbind first.`;
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
