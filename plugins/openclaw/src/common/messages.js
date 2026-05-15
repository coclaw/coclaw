// bind/unbind CLI 及 command 的用户提示文案（统一出口）

// data 容忍 undefined / 缺字段，避免 helper "非 JSON 兜底"分支返回无 payload 时抛 destructure TypeError
export function bindOk(data) {
	const { clawId = 'unknown', rebound, previousClawId } = data ?? {};
	const action = rebound ? 're-bound' : 'bound';
	const prev = previousClawId
		? ` (previous Claw ${previousClawId} was auto-unbound)`
		: '';
	return `OK. Claw (${clawId}) ${action} to CoClaw.${prev}`;
}

export function unbindOk(data) {
	const { clawId = 'unknown' } = data ?? {};
	return `OK. Claw (${clawId}) unbound from CoClaw.`;
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

// provider-auth CLI 输出（auth set-api-key / list / remove）

export function apiKeySetOk({ provider, profileId }) {
	return `OK. API key for "${provider}" stored (profileId=${profileId}).`;
}

export function authListEmpty(provider) {
	return provider
		? `No auth profiles found for provider "${provider}".`
		: 'No auth profiles found.';
}

/**
 * 把 list RPC 返回的 profiles 数组渲染成多行文本。
 * 每行格式：`<profileId>  <type>  <preview-or-meta>`
 * 调用方负责处理空数组（用 authListEmpty）。
 */
export function authListEntries(profiles) {
	const lines = profiles.map((p) => {
		const meta = [];
		if (p.keyPreview) meta.push(p.keyPreview);
		if (p.email) meta.push(p.email);
		if (p.displayName) meta.push(p.displayName);
		if (typeof p.expiresAt === 'number') {
			meta.push(`expires=${new Date(p.expiresAt).toISOString()}`);
		}
		const metaStr = meta.length > 0 ? `  ${meta.join('  ')}` : '';
		return `${p.profileId}  ${p.type}${metaStr}`;
	});
	return lines.join('\n');
}

export function authRemoveOk(provider) {
	return `OK. Removed all auth profiles for "${provider}".`;
}
