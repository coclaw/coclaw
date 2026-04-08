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

export const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
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
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

// 图片扩展名集（用于从路径判断是否为图片）
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

/**
 * 根据文件扩展名判断是否为图片
 * @param {string} path
 * @returns {boolean}
 */
export function isImageByExt(path) {
	const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
	return IMG_EXTS.has(ext);
}

// 语音扩展名集
const VOICE_EXTS = new Set(['webm', 'm4a', 'mp3', 'ogg', 'wav', 'aac']);

/**
 * 根据文件扩展名判断是否为语音
 * @param {string} path
 * @returns {boolean}
 */
export function isVoiceByExt(path) {
	const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
	return VOICE_EXTS.has(ext);
}

/**
 * 构造 chat 附件目录路径
 * @param {string} chatSessionKey - 如 'agent:main:main' 或 'agent:main:telegram:direct:123'
 * @returns {string} 如 '.coclaw/chat-files/main/2026-03'
 */
export function chatFilesDir(chatSessionKey) {
	const rest = chatSessionKey.split(':').slice(2).join(':');
	const escaped = rest.replaceAll(':', '--');
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	return `.coclaw/chat-files/${escaped}/${yyyy}-${mm}`;
}

/**
 * 构造 topic 附件目录路径
 * @param {string} topicId - topic 的 sessionId (UUID)
 * @returns {string} 如 '.coclaw/topic-files/a1b2c3d4-...'
 */
export function topicFilesDir(topicId) {
	return `.coclaw/topic-files/${topicId}`;
}

/**
 * 校验 coclaw-file workspace 相对路径
 * - 拒绝路径穿越（任何段为 ..）
 * - 拒绝绝对路径（/ 开头）
 * - 拒绝反斜杠路径（防御性兜底）
 * @param {string} path
 * @returns {boolean}
 */
export function validateCoclawPath(path) {
	if (!path) return false;
	if (path.startsWith('/')) return false;
	if (path.includes('\\')) return false;
	if (path.split('/').includes('..')) return false;
	return true;
}

/**
 * 从 markdown 文本中提取所有 coclaw-file: 引用。
 * 匹配 ![alt](coclaw-file:path) 和 [text](coclaw-file:path)，按出现顺序排列，按 path 去重。
 * @param {string} text
 * @returns {{ path: string, name: string, isImg: boolean, isVoice: boolean }[]}
 */
export function extractCoclawFileRefs(text) {
	if (!text) return [];
	const re = /!?\[([^\]]*)\]\((coclaw-file:[^)]+)\)/g;
	const refs = [];
	const seen = new Set();
	let match;
	while ((match = re.exec(text)) !== null) {
		const url = match[2];
		const path = url.slice('coclaw-file:'.length);
		if (seen.has(path) || !validateCoclawPath(path)) continue;
		seen.add(path);
		const name = match[1] || path.split('/').pop();
		refs.push({
			path,
			name,
			isImg: isImageByExt(path),
			isVoice: isVoiceByExt(path),
		});
	}
	return refs;
}

/**
 * 将 Blob 作为文件保存
 * - Web：创建 `<a download>` 触发浏览器下载
 * - Capacitor：写入 Cache → 调起系统分享面板 → 清理临时文件
 * @param {Blob} blob
 * @param {string} filename
 */
export async function saveBlobToFile(blob, filename) {
	const { isCapacitorApp } = await import('./platform.js');
	if (isCapacitorApp) {
		await __nativeShareFile(blob, filename);
		return;
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/**
 * Capacitor 原生：写临时文件 → 分享 → 清理
 * @param {Blob} blob
 * @param {string} filename
 */
async function __nativeShareFile(blob, filename) {
	const [{ Filesystem, Directory }, { Share }] = await Promise.all([
		import('@capacitor/filesystem'),
		import('@capacitor/share'),
	]);
	const base64 = await fileToBase64(blob);
	// 用唯一子目录隔离并发下载的同名文件，保留原始文件名供分享面板展示
	const cachePath = `coclaw_${Date.now()}/${filename}`;
	const { uri } = await Filesystem.writeFile({
		path: cachePath,
		data: base64,
		directory: Directory.Cache,
		recursive: true,
	});
	const cacheDir = cachePath.substring(0, cachePath.lastIndexOf('/'));
	try {
		await Share.share({ files: [uri] });
	} catch (err) {
		// 用户取消分享面板时 Capacitor 会 reject "Share canceled"，属正常操作不向上传播
		if (!/cancel/i.test(err?.message)) throw err;
	} finally {
		await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache })
			.catch((err) => console.warn('[saveBlobToFile] cache cleanup failed:', err));
		await Filesystem.rmdir({ path: cacheDir, directory: Directory.Cache })
			.catch((err) => console.warn('[saveBlobToFile] cache dir cleanup failed:', err));
	}
}

/** @internal 仅供测试 */
export { __nativeShareFile };

/** 附件信息块标题行 */
const ATTACHMENT_HEADING = '## coclaw-attachments 🗂';

/**
 * 构造附件信息块（markdown table）
 * @param {{ path: string, name: string, size: number }[]} files
 * @returns {string}
 */
export function buildAttachmentBlock(files) {
	if (!files?.length) return '';

	// 检测 name 碰撞：统计每个 name 出现次数
	const nameCounts = {};
	for (const f of files) {
		nameCounts[f.name] = (nameCounts[f.name] || 0) + 1;
	}
	const hasCollision = Object.values(nameCounts).some((c) => c > 1);

	const lines = [ATTACHMENT_HEADING, ''];
	if (hasCollision) {
		lines.push('| Path | Size | Name |');
		lines.push('|------|------|------|');
		for (const f of files) {
			const sizeStr = formatFileSize(f.size);
			// 碰撞的文件填入原始文件名，未碰撞的留空
			const nameCell = nameCounts[f.name] > 1 ? f.name : '';
			lines.push(`| ${f.path} | ${sizeStr} | ${nameCell} |`);
		}
	} else {
		lines.push('| Path | Size |');
		lines.push('|------|------|');
		for (const f of files) {
			const sizeStr = formatFileSize(f.size);
			lines.push(`| ${f.path} | ${sizeStr} |`);
		}
	}
	return lines.join('\n');
}

/**
 * 从消息文本中解析附件信息块
 * @param {string} text
 * @returns {{ cleanText: string, attachments: { path: string, size: string, name: string }[] }}
 */
export function parseAttachmentBlock(text) {
	if (!text) return { cleanText: '', attachments: [] };

	const headingIdx = text.indexOf(ATTACHMENT_HEADING);
	if (headingIdx === -1) return { cleanText: text, attachments: [] };

	const cleanText = text.slice(0, headingIdx).trimEnd();
	const blockText = text.slice(headingIdx + ATTACHMENT_HEADING.length);

	// 解析 markdown table 行
	const attachments = [];
	const lines = blockText.split('\n');
	// 找表头行确定列
	let hasNameCol = false;
	let tableStarted = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('|---')) {
			if (trimmed.startsWith('|---')) tableStarted = true;
			continue;
		}
		if (!trimmed.startsWith('|')) continue;

		// 表头行检测
		if (!tableStarted) {
			hasNameCol = /\bName\b/.test(trimmed);
			continue;
		}

		// 数据行：| path | size | [name] |
		const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
		if (cells.length >= 2) {
			attachments.push({
				path: cells[0],
				size: cells[1],
				name: hasNameCol && cells.length >= 3 ? cells[2] : '',
			});
		}
	}

	return { cleanText, attachments };
}
