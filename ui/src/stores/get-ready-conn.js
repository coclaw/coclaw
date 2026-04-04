import { useBotsStore } from './bots.store.js';
import { useBotConnections } from '../services/bot-connection-manager.js';

/**
 * 获取就绪的 BotConnection（链式容错）
 * dcReady=false、bot 不存在、conn 不存在 → 均返回 null
 * @param {string} botId
 * @returns {import('../services/bot-connection.js').BotConnection | null}
 */
export function getReadyConn(botId) {
	const id = String(botId);
	const store = useBotsStore();
	if (!store.byId[id]?.dcReady) return null;
	return useBotConnections().get(id) ?? null;
}
