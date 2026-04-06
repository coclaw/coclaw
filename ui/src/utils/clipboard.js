import { isCapacitorApp, isElectronApp, isTauriApp } from './platform.js';

/**
 * 跨平台写入剪贴板文本。
 * - Capacitor：走 @capacitor/clipboard 原生桥接（解决鸿蒙等非标 WebView 不支持 navigator.clipboard 的问题）
 * - Electron：走 IPC 桥接
 * - Tauri：走 clipboard-manager 插件
 * - Web：走 navigator.clipboard API
 * @param {string} text
 */
export async function writeClipboardText(text) {
	if (isCapacitorApp) {
		const { Clipboard } = await import('@capacitor/clipboard');
		await Clipboard.write({ string: text });
		return;
	}
	if (isElectronApp) {
		await window.electronAPI.clipboardWriteText(text);
		return;
	}
	if (isTauriApp) {
		await window.__TAURI__.clipboardManager.writeText(text);
		return;
	}
	await navigator.clipboard.writeText(text);
}
