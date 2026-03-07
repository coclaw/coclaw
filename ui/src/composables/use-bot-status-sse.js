import { onBeforeUnmount, ref } from 'vue';

import { useSessionsStore } from '../stores/sessions.store.js';

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
			connected.value = true;
			// 重连后立即全量同步，以捕获断开期间错过的变化
			botsStore.loadBots().catch(() => {});
		};

		es.onmessage = (evt) => {
			try {
				const data = JSON.parse(evt.data);
				if (data.event === 'bot.status') {
					botsStore.updateBotOnline(data.botId, data.online);
				}
				else if (data.event === 'bot.bound') {
					botsStore.addOrUpdateBot(data.bot);
				}
				else if (data.event === 'bot.unbound') {
					botsStore.removeBotById(data.botId);
					useSessionsStore().removeSessionsByBotId(data.botId);
				}
			}
			catch {}
		};

		es.onerror = () => {
			connected.value = false;
		};
	}

	function stop() {
		stopped = true;
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
	}

	start();
	onBeforeUnmount(stop);

	return { connected, stop };
}
