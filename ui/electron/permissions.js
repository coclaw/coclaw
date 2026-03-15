const TRUSTED_HOSTNAME = 'im.coclaw.net';

/**
 * 为信任域自动授予权限（对标 Android Manifest 权限预声明）
 * @param {Electron.Session} ses
 */
export function setupPermissions(ses) {
	// 同步权限检查
	ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
		try {
			const hostname = new URL(requestingOrigin).hostname;
			if (hostname === TRUSTED_HOSTNAME || hostname.endsWith('.coclaw.net')) {
				return true;
			}
		} catch { /* 忽略无效 URL */ }
		return false;
	});

	// 异步权限请求
	ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
		try {
			const url = details.requestingUrl || '';
			if (url.includes(TRUSTED_HOSTNAME)) {
				callback(true);
				return;
			}
		} catch { /* 忽略 */ }
		callback(false);
	});

	// 屏幕捕获请求处理（getDisplayMedia 拦截）
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
	});
}
