import { createRequire } from 'node:module';

import * as adminRepo from '../repos/admin.repo.js';
import { listOnlineBotIds } from '../bot-ws-hub.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');
// 插件版本：优先从构建时注入的环境变量读取，其次尝试 node_modules，最后 fallback null
function getPluginVersion() {
	if (process.env.COCLAW_PLUGIN_VERSION) return process.env.COCLAW_PLUGIN_VERSION;
	try { return require('@coclaw/openclaw-coclaw/package.json').version; } catch {}
	return null;
}

/**
 * @param {object} [deps] - 依赖注入
 * @param {object} [deps.repo] - admin repo
 * @param {Function} [deps.getOnlineBotCount] - 获取在线 bot 数
 */
export async function getAdminDashboard(deps = {}) {
	const repo = deps.repo ?? adminRepo;
	const getOnlineBotCount = deps.getOnlineBotCount ?? (() => listOnlineBotIds().size);

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [total, todayNew, todayActive, topActive, latestRegistered, botsTotal] = await Promise.all([
		repo.countUsers(),
		repo.countUsersCreatedSince(todayStart),
		repo.countUsersActiveSince(todayStart),
		repo.topActiveUsers(10),
		repo.latestRegisteredUsers(30),
		repo.countBots(),
	]);

	return {
		users: { total, todayNew, todayActive },
		topActiveUsers: topActive,
		latestRegisteredUsers: latestRegistered,
		bots: {
			total: botsTotal,
			online: getOnlineBotCount(),
		},
		version: {
			server: serverVersion,
			plugin: getPluginVersion(),
		},
	};
}
