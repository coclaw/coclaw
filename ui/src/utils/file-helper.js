/**
 * 将 File/Blob 读取为纯 base64 字符串（不含 data-url 前缀）
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
export function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(/** @type {string} */ (reader.result).split(',')[1]);
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
const VOICE_TYPES = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'];

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string}
 */
export function formatFileSize(bytes) {
	if (!bytes || bytes < 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 将 File/Blob 转为带元信息的对象
 * @param {File|Blob} blob
 * @returns {{ id: string, isImg: boolean, isVoice: boolean, label: string, name: string, ext: string, bytes: number, file: File|Blob, url: string|null }}
 */
export function formatFileBlob(blob) {
	const name = blob.name || 'file';
	const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
	const type = blob.type || '';
	const isImg = IMG_TYPES.some((t) => type.startsWith(t));
	const isVoice = VOICE_TYPES.some((t) => type.startsWith(t));
	const url = isImg ? URL.createObjectURL(blob) : null;

	return {
		id: crypto.randomUUID(),
		isImg,
		isVoice,
		label: formatFileSize(blob.size),
		name,
		ext,
		bytes: blob.size,
		file: blob,
		url,
	};
}
