// bind/unbind CLI 及 command 的用户提示文案（统一出口）

export function bindOk({ clawId, rebound, previousClawId }) {
	const action = rebound ? 're-bound' : 'bound';
	const prev = previousClawId
		? ` (previous Claw ${previousClawId} was auto-unbound)`
		: '';
	return `OK. Claw (${clawId}) ${action} to CoClaw.${prev}`;
}

export function unbindOk({ clawId }) {
	const id = clawId ?? 'unknown';
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
