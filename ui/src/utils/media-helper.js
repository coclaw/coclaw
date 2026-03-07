/**
 * 获得麦克风权限状态
 * @returns {Promise<'granted'|'denied'|'prompt'|null>}
 */
export async function queryMicPerm() {
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
const PREF_AUDIO_TYPES = [
	'audio/webm',
	'audio/m4a',
	'audio/mp4',
	'audio/mpeg',
	'audio/wav',
];

/**
 * 获取浏览器支持的最优音频 MIME type
 * @returns {string|null}
 */
export function getPrefAudioType() {
	if (typeof MediaRecorder === 'undefined') return null;
	for (const type of PREF_AUDIO_TYPES) {
		if (MediaRecorder.isTypeSupported(type)) {
			return type;
		}
	}
	return null;
}
