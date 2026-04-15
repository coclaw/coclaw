import { remoteLog } from './remote-log.js';
import { adminStreamUrl } from './admin.api.js';

const HB_TIMEOUT_MS = 65_000; // server 30s 心跳间隔，留 ~2x 余量
const RESTART_THROTTLE_MS = 500; // 节流，防 app:foreground + network:online 同时触发

/**
 * 连接 admin SSE 流并分发事件（snapshot / statusChanged / infoUpdated）。
 * 内置心跳超时（65s）自动重连，响应 app:foreground 与 network:online。
 * 调用方在 mounted 调用，beforeUnmount 调 close()。
 *
 * @param {object} handlers - 事件回调（全部可选；缺失时忽略对应事件）
 * @param {(ids: string[]) => void} [handlers.onSnapshot]
 * @param {(evt: { clawId: string, online: boolean }) => void} [handlers.onStatusChanged]
 * @param {(evt: { clawId: string, name: string|null, hostName: string|null, pluginVersion: string|null, agentModels: any }) => void} [handlers.onInfoUpdated]
 * @returns {{ close: () => void }}
 */
export function connectAdminStream(handlers = {}) {
	const { onSnapshot, onStatusChanged, onInfoUpdated } = handlers;
	let es = null;
	let stopped = false;
	let hbTimer = null;
	let lastRestartAt = 0;

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
				case 'claw.infoUpdated':
					onInfoUpdated?.({
						clawId: String(data.clawId),
						name: data.name ?? null,
						hostName: data.hostName ?? null,
						pluginVersion: data.pluginVersion ?? null,
						agentModels: data.agentModels ?? null,
					});
					break;
				case 'heartbeat':
					break;
			}
		};

		es.onerror = () => {
			console.debug('[admin-sse] error/disconnected');
			remoteLog('adminSse.error');
			clearHbTimer();
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
