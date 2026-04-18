import { onBeforeUnmount, ref } from 'vue';
import { remoteLog } from '../services/remote-log.js';

const HB_TIMEOUT_MS = 65_000; // server 30s 间隔，留 ~2x 余量
const RESTART_THROTTLE_MS = 500; // restart 节流，防 app:foreground + network:online 同时触发

/**
 * 通过 SSE 实时接收 claw 快照、状态变更及解绑通知。
 * 连接建立后 server 推送全量快照（claw.snapshot），后续增量更新。
 * 内置心跳超时检测：超过 65s 未收到任何数据则自动重建连接。
 *
 * 生命周期：
 * - autoStart=true（默认）：创建即 start，onBeforeUnmount 自动 stop + dispose。
 * - autoStart=false：需手动 start；stop 后可重新 start；onBeforeUnmount 后 dispose 永久禁用。
 *
 * @param {import('pinia').Store} clawsStore - claws store 实例
 * @param {object} [opts]
 * @param {boolean} [opts.autoStart=true] - 是否在创建时自动启动
 * @returns {{ connected: import('vue').Ref<boolean>, start: () => void, stop: () => void }}
 */
export function useClawStatusSse(clawsStore, { autoStart = true } = {}) {
	const connected = ref(false);
	let es = null;
	let running = false;
	let disposed = false;
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

	function openEventSource() {
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
				if (data.event !== 'heartbeat') {
					console.info('[SSE] event=%s', data.event, data);
				}
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

	function start() {
		if (disposed || running) return;
		running = true;
		openEventSource();
		window.addEventListener('app:foreground', onForeground);
		window.addEventListener('network:online', onNetworkOnline);
	}

	/** 强制重建 SSE 连接（前台恢复 / 心跳超时时调用） */
	function restart() {
		if (disposed || !running) return;
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
		// 仅重建 ES，不重装 window 监听器（它们跟随 running 生命周期，start/stop 成对管理）
		openEventSource();
	}

	function onForeground() {
		restart();
	}

	function onNetworkOnline() {
		restart();
	}

	function stop() {
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		clearHbTimer();
		if (!running) return; // 未 running 时仅兜底清理，不动 listener
		running = false;
		window.removeEventListener('app:foreground', onForeground);
		window.removeEventListener('network:online', onNetworkOnline);
	}

	if (autoStart) start();

	onBeforeUnmount(() => {
		stop();
		disposed = true;
	});

	return { connected, start, stop };
}
