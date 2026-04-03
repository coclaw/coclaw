/**
 * 跨平台打开外部 URL
 * - Capacitor：In-App Browser（Custom Tabs / SFSafariViewController）
 * - Tauri：系统默认浏览器（通过 shell.open）
 * - Web：新标签页
 */
import { isCapacitorApp, isTauriApp } from './platform.js';

/**
 * 打开外部 URL（自动适配当前平台）
 * @param {string} url - 目标 URL
 */
export async function openExternalUrl(url) {
	if (isCapacitorApp) {
		const { Browser } = await import('@capacitor/browser');
		await Browser.open({ url });
	} else if (isTauriApp) {
		await window.__TAURI__.shell.open(url);
	} else {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
}
