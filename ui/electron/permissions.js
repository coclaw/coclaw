const TRUSTED_HOSTNAME = 'im.coclaw.net';

/** 允许对信任域自动授予的权限（对标设计文档 §5.4） */
const ALLOWED_PERMISSIONS = new Set([
	'media',
	'notifications',
	'clipboard-read',
	'clipboard-sanitized-write',
	'fullscreen',
	'display-capture',
]);

/**
 * hostname 是否属于信任域（im.coclaw.net 或 *.coclaw.net）
 * @param {string} hostname
 */
function isTrustedHostname(hostname) {
	if (!hostname) return false;
	return hostname === TRUSTED_HOSTNAME || hostname.endsWith('.coclaw.net');
}

/**
 * 从 URL 字符串中取 hostname（失败返回空字符串）
 * @param {string} urlStr
 */
function safeHostname(urlStr) {
	try {
		return new URL(urlStr).hostname;
	}
	catch {
		return '';
	}
}

/**
 * 为信任域自动授予权限（对标 Android Manifest 权限预声明）
 * @param {Electron.Session} ses
 */
export function setupPermissions(ses) {
	// 同步权限检查
	ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
		if (!ALLOWED_PERMISSIONS.has(permission)) return false;
		return isTrustedHostname(safeHostname(requestingOrigin));
	});

	// 异步权限请求
	ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
		if (!ALLOWED_PERMISSIONS.has(permission)) {
			callback(false);
			return;
		}
		const hostname = safeHostname(details?.requestingUrl || '');
		callback(isTrustedHostname(hostname));
	});

	// 屏幕捕获请求处理（getDisplayMedia 拦截）。
	// useSystemPicker: true → macOS 12.3+ / Windows 11 24H2+ 走 OS 原生 picker，
	// 用户可选择屏/窗口/画面分享，体验和隐私都优于强行选 sources[0]。
	// 系统不支持原生 picker 时会回落到下面的 callback，这里保持取第一屏的兜底。
	ses.setDisplayMediaRequestHandler(async (_request, callback) => {
		const { desktopCapturer } = await import('electron');
		try {
			const sources = await desktopCapturer.getSources({ types: ['screen'] });
			if (sources.length > 0) {
				callback({ video: sources[0] });
			} else {
				callback({});
			}
		} catch {
			callback({});
		}
	}, { useSystemPicker: true });
}
