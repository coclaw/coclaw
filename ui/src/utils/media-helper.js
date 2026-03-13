/**
 * 获得麦克风权限状态
 * @returns {Promise<'granted'|'denied'|'prompt'|null>}
 */
export async function queryMicPerm() {
	// Capacitor WebView 中 permissions.query 不可靠，跳过
	if (window.Capacitor?.isNativePlatform()) return null;
	if (!navigator.permissions) return null;
	try {
		const perm = await navigator.permissions.query({ name: 'microphone' });
		return perm.state;
	}
	catch {
		return null;
	}
}

/**
 * 判断系统是否有麦克风设备
 * @returns {Promise<boolean|null>}
 */
export async function hasMicDev() {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.some((d) => d.kind === 'audioinput');
	}
	catch {
		return null;
	}
}

// 按优先顺序排列的 MIME types
// iOS WKWebView 对 webm 支持不稳定，优先 mp4
const PREF_AUDIO_TYPES_IOS = [
	'audio/mp4',
	'audio/m4a',
	'audio/webm',
	'audio/mpeg',
	'audio/wav',
];
const PREF_AUDIO_TYPES_DEFAULT = [
	'audio/webm',
	'audio/m4a',
	'audio/mp4',
	'audio/mpeg',
	'audio/wav',
];

function isIOS() {
	return /iPad|iPhone|iPod/.test(navigator.userAgent)
		|| (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * 获取浏览器支持的最优音频 MIME type
 * @returns {string|null}
 */
export function getPrefAudioType() {
	if (typeof MediaRecorder === 'undefined') return null;
	const types = isIOS() ? PREF_AUDIO_TYPES_IOS : PREF_AUDIO_TYPES_DEFAULT;
	for (const type of types) {
		if (MediaRecorder.isTypeSupported(type)) {
			return type;
		}
	}
	return null;
}
