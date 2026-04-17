import { remoteLog } from './remote-log.js';
import { adminStreamUrl } from './admin.api.js';

const HB_TIMEOUT_MS = 65_000; // server 30s 心跳间隔，留 ~2x 余量
const RESTART_THROTTLE_MS = 500; // 节流，防 app:foreground + network:online 同时触发
const ERROR_BEFORE_OPEN_LIMIT = 3; // 未 onopen 的情况下连续 onerror 超过此阈值即熔断（握手被拒）

/**
 * 连接 admin SSE 流并分发事件（snapshot / statusChanged / infoUpdated）。
 * 内置心跳超时（65s）自动重连，响应 app:foreground 与 network:online。
 * 调用方在 mounted 调用，beforeUnmount 调 close()。
 *
 * 握手熔断：如果 onopen 从未成功且连续 onerror 达到 ERROR_BEFORE_OPEN_LIMIT 次
 * （即服务端持续拒绝握手，如 401/403），此连接会停止并不再重连。
 * **恢复方式**：熔断后需外部重新调用 connectAdminStream（或刷新页面 / 重新进入 /admin/*
 * 触发 AdminLayout 重新 startStream）；仅 app:foreground / network:online 事件无法唤醒。
 * 生产期断线（已 onopen 成功过）不会触发熔断，心跳超时路径正常重连。
 *
 * @param {object} handlers - 事件回调（全部可选；缺失时忽略对应事件）
 * @param {(ids: string[]) => void} [handlers.onSnapshot]
 * @param {(evt: { clawId: string, online: boolean }) => void} [handlers.onStatusChanged]
 * @param {(patch: { clawId: string, name?: string|null, hostName?: string|null, pluginVersion?: string|null, agentModels?: any }) => void} [handlers.onInfoUpdated]
 *   patch 语义：除 clawId 外字段按本次 plugin 上报的 patch 实际出现与否可选；未出现的字段代表"保持原值"
 * @returns {{ close: () => void }}
 */
export function connectAdminStream(handlers = {}) {
	const { onSnapshot, onStatusChanged, onInfoUpdated } = handlers;
	let es = null;
	let stopped = false;
	let hbTimer = null;
	let lastRestartAt = 0;
	// 握手失败计数：onerror 发生而 onopen 从未成功则递增。
	// 连续超过 ERROR_BEFORE_OPEN_LIMIT 次 → 认定为权限/策略拒绝，熔断停止重连。
	// 一旦 onopen 过一次（handshakeSucceededOnce=true），生产期错误不再累计。
	let handshakeErrors = 0;
	let handshakeSucceededOnce = false;

	function resetHbTimer() {
		clearTimeout(hbTimer);
		hbTimer = setTimeout(() => {
			console.warn('[admin-sse] heartbeat timeout, restarting');
			remoteLog('adminSse.hbTimeout');
			restart();
		}, HB_TIMEOUT_MS);
	}

	function clearHbTimer() {
		clearTimeout(hbTimer);
		hbTimer = null;
	}

	function start() {
		if (stopped || es) return;
		es = new EventSource(adminStreamUrl());

		es.onopen = () => {
			console.debug('[admin-sse] connected');
			remoteLog('adminSse.connected');
			handshakeSucceededOnce = true;
			handshakeErrors = 0;
			resetHbTimer();
		};

		es.onmessage = (evt) => {
			resetHbTimer();
			let data;
			try {
				data = JSON.parse(evt.data);
			}
			catch (err) {
				console.warn('[admin-sse] parse error', err);
				return;
			}
			switch (data.event) {
				case 'snapshot':
					onSnapshot?.(Array.isArray(data.onlineClawIds) ? data.onlineClawIds : []);
					break;
				case 'claw.statusChanged':
					onStatusChanged?.({ clawId: String(data.clawId), online: !!data.online });
					break;
				case 'claw.infoUpdated': {
					// patch 语义：wire 层仅携带本次变更字段；透传时保留 undefined，
					// 让 store.updateClawInfo 的 "skip undefined" 逻辑只覆盖本次实际变更的字段
					const patch = { clawId: String(data.clawId) };
					if (Object.hasOwn(data, 'name')) patch.name = data.name;
					if (Object.hasOwn(data, 'hostName')) patch.hostName = data.hostName;
					if (Object.hasOwn(data, 'pluginVersion')) patch.pluginVersion = data.pluginVersion;
					if (Object.hasOwn(data, 'agentModels')) patch.agentModels = data.agentModels;
					onInfoUpdated?.(patch);
					break;
				}
				case 'heartbeat':
					break;
			}
		};

		es.onerror = () => {
			console.debug('[admin-sse] error/disconnected');
			remoteLog('adminSse.error');
			clearHbTimer();
			// 仅在从未握手成功过的连接上统计错误：超过阈值 → 熔断（避免对非授权用户死循环重连）
			if (handshakeSucceededOnce) return;
			handshakeErrors += 1;
			if (handshakeErrors >= ERROR_BEFORE_OPEN_LIMIT) {
				console.warn('[admin-sse] handshake blocked after %d attempts, stopping', handshakeErrors);
				remoteLog(`adminSse.handshakeBlocked n=${handshakeErrors}`);
				stopped = true;
				if (es) {
					es.close();
					es = null;
				}
			}
		};
	}

	function restart() {
		if (stopped) return;
		const now = Date.now();
		if (now - lastRestartAt < RESTART_THROTTLE_MS) return;
		lastRestartAt = now;
		if (es) {
			es.close();
			es = null;
		}
		clearHbTimer();
		start();
	}

	function onForeground() {
		restart();
	}

	function onNetworkOnline() {
		restart();
	}

	function close() {
		stopped = true;
		if (es) {
			es.close();
			es = null;
		}
		clearHbTimer();
		window.removeEventListener('app:foreground', onForeground);
		window.removeEventListener('network:online', onNetworkOnline);
	}

	start();
	window.addEventListener('app:foreground', onForeground);
	window.addEventListener('network:online', onNetworkOnline);

	return { close };
}
