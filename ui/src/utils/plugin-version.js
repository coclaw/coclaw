/**
 * 插件版本检查工具
 */

/** UI 要求的最低插件版本 */
export const MIN_PLUGIN_VERSION = '0.4.0';

/**
 * 比较语义化版本（仅 major.minor.patch）
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 | 0 | 1
 */
function compareSemver(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na < nb) return -1;
		if (na > nb) return 1;
	}
	return 0;
}

/**
 * 检查插件版本并获取插件信息
 * @param {object} conn - ClawConnection 实例
 * @returns {Promise<{ ok: boolean, version: string|null, clawVersion: string|null, name: string|null, hostName: string|null }>}
 */
export async function checkPluginVersion(conn) {
	try {
		const result = await conn.request('coclaw.info', {}, { timeout: 10_000 });
		const version = result?.version;
		const clawVersion = result?.clawVersion ?? null;
		const name = result?.name ?? null;
		const hostName = result?.hostName ?? null;
		if (!version || typeof version !== 'string') {
			console.debug('[plugin-version] coclaw.info returned no version');
			return { ok: false, version: null, clawVersion, name, hostName };
		}
		const ok = compareSemver(version, MIN_PLUGIN_VERSION) >= 0;
		console.debug('[plugin-version] version=%s clawVersion=%s min=%s ok=%s', version, clawVersion, MIN_PLUGIN_VERSION, ok);
		return { ok, version, clawVersion, name, hostName };
	}
	catch (err) {
		// RPC 方法不存在（旧版插件）或其他错误
		console.debug('[plugin-version] coclaw.info failed: %s', err?.message);
		return { ok: false, version: null, clawVersion: null, name: null, hostName: null };
	}
}
