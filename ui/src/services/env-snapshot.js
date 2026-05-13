/**
 * 一次性诊断快照采集与 ui.start log 文本格式化。
 *
 * 不同于 `stores/env.store.js`（响应式 UI 状态，服务于组件 watch），本模块产出**不变快照**——
 * 在 app 启动时拍一下，用作 remote-log 的首条诊断日志内容，之后不再更新。
 *
 * 设计文档：docs/designs/ui-remote-log-http-channel.md（ui.start 字段口径）
 */
import { detectPlatformLabel } from '../utils/platform.js';

/**
 * 构造 `ui.start` 首条诊断日志文本。可选字段取不到时整字段省略，不写 `unknown` 占位。
 *
 * @param {string} uiId - remote-log 实例的 uiId（虽然 payload envelope 也带 uiId，文本里再带便于 grep 日志时单条自含上下文）
 * @returns {string}
 */
export function buildUiStartText(uiId) {
	const parts = [`uiId=${uiId}`];
	const version = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || 'unknown';
	parts.push(`version=${version}`);
	parts.push(`platform=${detectPlatformLabel()}`);
	if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') {
		const dpr = window.devicePixelRatio || 1;
		parts.push(`viewport=${window.innerWidth}x${window.innerHeight}@${dpr}`);
	}
	if (typeof navigator !== 'undefined') {
		const touch = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0;
		parts.push(`touch=${touch ? 'yes' : 'no'}`);
	}
	parts.push(`theme=${detectTheme()}`);
	if (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)) {
		parts.push(`cores=${navigator.hardwareConcurrency}`);
	}
	if (typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory)) {
		parts.push(`mem=${navigator.deviceMemory}`);
	}
	const tz = tryDetectTimeZone();
	if (tz) parts.push(`tz=${tz}`);
	if (typeof navigator !== 'undefined' && navigator.language) {
		parts.push(`lang=${navigator.language}`);
	}
	if (typeof navigator !== 'undefined') {
		const net = navigator.connection?.effectiveType;
		if (net) parts.push(`net=${net}`);
	}
	if (typeof navigator !== 'undefined' && navigator.userAgent) {
		parts.push(`ua="${navigator.userAgent}"`);
	}
	return `ui.start ${parts.join(' ')}`;
}

function tryDetectTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
	} catch {
		return '';
	}
}

function detectTheme() {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'no-pref';
	try {
		if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
		if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
	} catch {
		return 'no-pref';
	}
	return 'no-pref';
}
