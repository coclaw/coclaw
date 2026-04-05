import { onBeforeUnmount, ref } from 'vue';
import { remoteLog } from '../services/remote-log.js';

const HB_TIMEOUT_MS = 65_000; // server 30s 间隔，留 ~2x 余量
const RESTART_THROTTLE_MS = 500; // restart 节流，防 app:foreground + network:online 同时触发

/**
 * 通过 SSE 实时接收 claw 快照、状态变更及解绑通知。
 * 连接建立后 server 推送全量快照（claw.snapshot），后续增量更新。
 * 内置心跳超时检测：超过 65s 未收到任何数据则自动重建连接。
 * @param {import('pinia').Store} clawsStore - claws store 实例
 * @returns {{ connected: import('vue').Ref<boolean>, stop: () => void }}
 */
export function useClawStatusSse(clawsStore) {
	const connected = ref(false);
	let es = null;
	let stopped = false;
	let hbTimer = null;
	let lastRestartAt = 0;

	function resetHbTimer() {
		clearTimeout(hbTimer);
		hbTimer = setTimeout(() => {
			console.warn('[SSE] heartbeat timeout, restarting');
			remoteLog('sse.hbTimeout');
			connected.value = false;
			restart();
		}, HB_TIMEOUT_MS);
	}

	function clearHbTimer() {
		clearTimeout(hbTimer);
		hbTimer = null;
	}

	function start() {
		if (stopped || es) return;
		es = new EventSource('/api/v1/claws/status-stream');

		es.onopen = () => {
			console.debug('[SSE] connected');
			remoteLog('sse.connected');
			connected.value = true;
			resetHbTimer();
		};

		es.onmessage = (evt) => {
			resetHbTimer();
			try {
				const data = JSON.parse(evt.data);
				console.debug('[SSE] event=%s', data.event, data);
				switch (data.event) {
					case 'claw.snapshot':
						clawsStore.applySnapshot(data.items);
						break;
					case 'claw.status':
						clawsStore.updateClawOnline(data.clawId, data.online);
						break;
					case 'claw.nameUpdated':
						clawsStore.addOrUpdateClaw({ id: data.clawId, name: data.name });
						break;
					case 'claw.bound':
						clawsStore.addOrUpdateClaw(data.claw);
						break;
					case 'claw.unbound':
						clawsStore.removeClawById(data.clawId);
						break;
					case 'heartbeat':
						break;
				}
			}
			catch (err) {
				console.warn('[SSE] message handling error', err);
			}
		};

		es.onerror = () => {
			console.debug('[SSE] error/disconnected');
			remoteLog('sse.error');
			connected.value = false;
			clearHbTimer();
		};
	}

	/** 强制重建 SSE 连接（前台恢复 / 心跳超时时调用） */
	function restart() {
		if (stopped) return;
		const now = Date.now();
		if (now - lastRestartAt < RESTART_THROTTLE_MS) return;
		lastRestartAt = now;
		console.debug('[SSE] restart');
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		clearHbTimer();
		start();
	}

	function onForeground() {
		restart();
	}

	function onNetworkOnline() {
		restart();
	}

	function stop() {
		stopped = true;
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		clearHbTimer();
		window.removeEventListener('app:foreground', onForeground);
		window.removeEventListener('network:online', onNetworkOnline);
	}

	start();
	window.addEventListener('app:foreground', onForeground);
	window.addEventListener('network:online', onNetworkOnline);
	onBeforeUnmount(stop);

	return { connected, stop };
}
