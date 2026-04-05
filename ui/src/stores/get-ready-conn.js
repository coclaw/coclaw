import { useClawsStore } from './claws.store.js';
import { useClawConnections } from '../services/claw-connection-manager.js';

/**
 * 获取就绪的 ClawConnection（链式容错）
 * dcReady=false、claw 不存在、conn 不存在 → 均返回 null
 * @param {string} clawId
 * @returns {import('../services/claw-connection.js').ClawConnection | null}
 */
export function getReadyConn(clawId) {
	const id = String(clawId);
	const store = useClawsStore();
	if (!store.byId[id]?.dcReady) return null;
	return useClawConnections().get(id) ?? null;
}
