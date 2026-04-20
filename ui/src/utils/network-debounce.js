/**
 * network:online trailing-edge debounce。
 * 独立于 capacitor-app.js 以便 auth.store 等模块引用时不被 Capacitor / Nuxt UI 等重依赖拖入测试环境。
 *
 * Android wifi 开关瞬间会连发 wifi→cellular→wifi 两次 typeChanged 事件，实测间隔可达 500-900ms；
 * 1200ms 覆盖观察到的最坏样本并留足安全边际，对 ICE restart 启动延迟无感。
 */
import { remoteLog } from '../services/remote-log.js';

const NETWORK_ONLINE_DEBOUNCE_MS = 1200;
/** 窗口内累计 typeChanged 的 OR 聚合（任一事件为 true → 最终派发 true） */
let _pendingTypeChanged = false;
/** 窗口内累计的事件数，用于 merged 日志诊断 */
let _pendingCount = 0;
/** 当前 debounce timer 句柄；null 表示无活跃窗口 */
let _debounceTimer = null;

/**
 * 派发 network:online，在源头做 trailing-edge debounce。
 * - 每次事件重置窗口，窗口无新事件后以聚合结果派发一次
 * - typeChanged 做 OR 聚合：窗口内任何一次为 true → 最终派发 typeChanged=true
 *   （wifi→cellular→wifi 即便首尾 type 相同，中间真的切过，消费端仍需做完整 restart）
 * @param {boolean} typeChanged
 */
export function dispatchNetworkOnline(typeChanged) {
	_pendingTypeChanged = _pendingTypeChanged || typeChanged;
	_pendingCount++;
	if (_debounceTimer) clearTimeout(_debounceTimer);
	_debounceTimer = setTimeout(() => {
		const detail = { typeChanged: _pendingTypeChanged };
		const merged = _pendingCount;
		_pendingTypeChanged = false;
		_pendingCount = 0;
		_debounceTimer = null;
		if (merged > 1) {
			remoteLog(`app.network merged count=${merged} typeChanged=${detail.typeChanged}`);
		}
		window.dispatchEvent(new CustomEvent('network:online', { detail }));
	}, NETWORK_ONLINE_DEBOUNCE_MS);
}

/**
 * 取消尚未派发的 network:online pending 事件并清空 debounce 状态。
 * - 生产用：logout 清理链在此处丢弃 in-flight timer，避免 1200ms 后对刚登出的环境派发事件
 * - 测试用：beforeEach 复位模块单例，避免背靠背用例互相污染
 */
export function __cancelPendingNetworkDispatch() {
	if (_debounceTimer) clearTimeout(_debounceTimer);
	_debounceTimer = null;
	_pendingTypeChanged = false;
	_pendingCount = 0;
}

/** @internal 单测专用：立即冲刷 pending dispatch（绕过 setTimeout，便于同步断言事件） */
export function __flushNetworkDebounceForTest() {
	if (!_debounceTimer) return;
	clearTimeout(_debounceTimer);
	const detail = { typeChanged: _pendingTypeChanged };
	_pendingTypeChanged = false;
	_pendingCount = 0;
	_debounceTimer = null;
	window.dispatchEvent(new CustomEvent('network:online', { detail }));
}
