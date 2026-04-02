// bind/unbind CLI 及 command 的用户提示文案（统一出口）

export function bindOk({ botId, rebound, previousBotId }) {
	const action = rebound ? 're-bound' : 'bound';
	const prev = previousBotId
		? ` (previous Claw ${previousBotId} was auto-unbound)`
		: '';
	return `OK. Claw (${botId}) ${action} to CoClaw.${prev}`;
}

export function unbindOk({ botId }) {
	const id = botId ?? 'unknown';
	return `OK. Claw (${id}) unbound from CoClaw.`;
}

export function notBound() {
	return 'Not bound. Nothing to unbind.';
}

export function claimCodeCreated({ code, appUrl, expiresMinutes }) {
	return [
		`Claim code: ${code}`,
		`Open this URL to complete binding: ${appUrl}`,
		`The code expires in ${expiresMinutes} minutes.`,
		'',
		"If you don't have a CoClaw account yet, you can register on that page.",
	].join('\n');
}
