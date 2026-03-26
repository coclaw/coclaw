import { onBeforeUnmount } from 'vue';

const POLL_INTERVAL = 30_000;

/**
 * 可见性感知的 bot 状态轮询（SSE 连通时自动跳过）
 * @param {import('pinia').Store} botsStore - bots store 实例
 * @param {{ sseConnected?: import('vue').Ref<boolean> }} [opts]
 * @returns {{ stop: () => void }}
 */
export function useBotStatusPoll(botsStore, opts = {}) {
	const { sseConnected } = opts;
	let timerId = null;
	let stopped = false;

	function schedule() {
		if (stopped) return;
		pause(); // 确保只有一条活跃定时器链
		timerId = setTimeout(async () => {
			if (!sseConnected?.value) {
				try {
					await botsStore.loadBots();
				}
				catch {
					// 静默忽略，避免轮询失败干扰用户
				}
			}
			schedule();
		}, POLL_INTERVAL);
	}

	function pause() {
		if (timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
		}
	}

	async function resume() {
		if (stopped) return;
		pause(); // 清除已有定时器，防止多事件源（visibility + foreground + network）产生并行轮询链
		if (!sseConnected?.value) {
			try {
				await botsStore.loadBots();
			}
			catch {
				// 静默忽略
			}
		}
		schedule();
	}

	function onVisibilityChange() {
		if (document.visibilityState === 'hidden') {
			pause();
		}
		else {
			resume();
		}
	}

	function onForeground() {
		resume();
	}

	function onNetworkOnline() {
		resume();
	}

	function stop() {
		stopped = true;
		pause();
		document.removeEventListener('visibilitychange', onVisibilityChange);
		window.removeEventListener('app:foreground', onForeground);
		window.removeEventListener('network:online', onNetworkOnline);
	}

	// 启动
	document.addEventListener('visibilitychange', onVisibilityChange);
	window.addEventListener('app:foreground', onForeground);
	window.addEventListener('network:online', onNetworkOnline);
	schedule();

	onBeforeUnmount(stop);

	return { stop };
}
