/**
 * 应用自动更新服务
 *
 * 定期轮询 /version.json 检测新版本，在安全时机自动 reload。
 * 适用于 Capacitor WebView 等长期存活的运行环境。
 */
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useFilesStore } from '../stores/files.store.js';
import { chatStoreManager } from '../stores/chat-store-manager.js';

const POLL_INTERVAL_MS = 10 * 60_000; // 10 分钟
const RELOAD_CHECK_INTERVAL_MS = 10_000; // 10 秒

let started = false;
let updateAvailable = false;
let reloadTimer = null;

/**
 * 启动版本检测（幂等，仅首次调用生效）
 */
export function startUpdateCheck() {
	if (started || import.meta.env.DEV) return;
	started = true;
	console.log('[app-update] started, current=%s, poll=%ds', __APP_VERSION__, POLL_INTERVAL_MS / 1000);
	setTimeout(pollVersion, POLL_INTERVAL_MS);
}

/**
 * 轮询 /version.json
 */
async function pollVersion() {
	try {
		const res = await fetch('/version.json', { cache: 'no-store' });
		if (res.ok) {
			const data = await res.json();
			if (data.version && data.version !== __APP_VERSION__) {
				console.log('[app-update] update available: %s → %s', __APP_VERSION__, data.version);
				updateAvailable = true;
				scheduleReload();
				return; // 停止轮询
			}
			// console.debug('[app-update] version unchanged: %s', data.version); // 不再需要了
		}
	} catch (err) {
		console.warn('[app-update] poll failed:', err.message || err);
	}
	setTimeout(pollVersion, POLL_INTERVAL_MS);
}

/**
 * 检查是否有阻止 reload 的活跃业务
 * @returns {boolean}
 */
export function isReloadBlocked() {
	// agent run 未完成
	if (useAgentRunsStore().busy) return true;
	// 任一 chatStore 有不可中断操作
	for (const store of chatStoreManager.stores()) {
		if (store.busy) return true;
	}
	// 文件传输进行中
	if (useFilesStore().busy) return true;
	return false;
}

/**
 * 开始尝试安全 reload
 */
function scheduleReload() {
	// 立即尝试一次
	if (tryReload()) return;

	// 监听 app:foreground（Capacitor 从后台恢复）
	window.addEventListener('app:foreground', tryReload);

	// 兜底轮询
	reloadTimer = setInterval(tryReload, RELOAD_CHECK_INTERVAL_MS);
}

/**
 * 尝试 reload，成功返回 true
 * @returns {boolean}
 */
function tryReload() {
	if (!updateAvailable) return false;
	if (isReloadBlocked()) {
		console.debug('[app-update] reload blocked: busy');
		return false;
	}
	console.log('[app-update] reloading now');
	location.reload();
	return true;
}

function cleanup() {
	window.removeEventListener('app:foreground', tryReload);
	if (reloadTimer) {
		clearInterval(reloadTimer);
		reloadTimer = null;
	}
}

/** @internal 仅供测试 */
export function __reset() {
	cleanup();
	started = false;
	updateAvailable = false;
}

/** @internal 仅供测试 */
export { updateAvailable as __updateAvailable };
