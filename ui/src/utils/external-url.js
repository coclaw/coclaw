/**
 * 跨平台打开外部 URL
 * - Capacitor：In-App Browser（Custom Tabs / SFSafariViewController）
 * - Electron：系统默认浏览器（通过 shell.openExternal）
 * - Tauri：系统默认浏览器（通过 shell.open，保留待用）
 * - Web：新标签页
 */
import { isCapacitorApp, isElectronApp, isTauriApp } from './platform.js';

/**
 * 打开外部 URL（自动适配当前平台）
 * @param {string} url - 目标 URL
 */
export async function openExternalUrl(url) {
	try {
		if (isCapacitorApp) {
			const { Browser } = await import('@capacitor/browser');
			await Browser.open({ url });
		} else if (isElectronApp) {
			await window.electronAPI.openExternal(url);
		} else if (isTauriApp) {
			await window.__TAURI__.shell.open(url);
		} else {
			window.open(url, '_blank', 'noopener,noreferrer');
		}
	} catch {
		// 原生 API 失败时兜底：Capacitor iOS 上不一定可靠，但总比无响应好
		window.open(url, '_blank', 'noopener,noreferrer');
	}
}
