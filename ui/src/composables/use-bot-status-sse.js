import { onBeforeUnmount, ref } from 'vue';

/**
 * 通过 SSE 实时接收 bot 在线状态变更及解绑通知
 * @param {import('pinia').Store} botsStore - bots store 实例
 * @returns {{ connected: import('vue').Ref<boolean>, stop: () => void }}
 */
export function useBotStatusSse(botsStore) {
	const connected = ref(false);
	let es = null;
	let stopped = false;

	function start() {
		if (stopped || es) {
			return;
		}
		es = new EventSource('/api/v1/bots/status-stream');

		es.onopen = () => {
			console.debug('[SSE] connected');
			connected.value = true;
			// 重连后立即全量同步，以捕获断开期间错过的变化
			botsStore.loadBots().catch(() => {});
		};

		es.onmessage = (evt) => {
			try {
				const data = JSON.parse(evt.data);
				console.debug('[SSE] event=%s', data.event, data);
				if (data.event === 'bot.status') {
					botsStore.updateBotOnline(data.botId, data.online);
				}
				else if (data.event === 'bot.nameUpdated') {
					botsStore.addOrUpdateBot({ id: data.botId, name: data.name });
				}
				else if (data.event === 'bot.bound') {
					botsStore.addOrUpdateBot(data.bot);
				}
				else if (data.event === 'bot.unbound') {
					// removeBotById 内部已清理关联 session，无需重复调用
					botsStore.removeBotById(data.botId);
				}
			}
			catch {}
		};

		es.onerror = () => {
			console.debug('[SSE] error/disconnected');
			connected.value = false;
		};
	}

	/** 强制重建 SSE 连接（前台恢复时调用） */
	function restart() {
		if (stopped) return;
		console.debug('[SSE] restart (foreground resume)');
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		start();
	}

	function onForeground() {
		restart();
	}

	function stop() {
		stopped = true;
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		window.removeEventListener('app:foreground', onForeground);
	}

	start();
	window.addEventListener('app:foreground', onForeground);
	onBeforeUnmount(stop);

	return { connected, stop };
}
