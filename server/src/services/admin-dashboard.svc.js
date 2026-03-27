import { createRequire } from 'node:module';

import * as adminRepo from '../repos/admin.repo.js';
import { listOnlineBotIds } from '../bot-ws-hub.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');

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

	const [total, todayNew, todayActive, topActive, botsTotal] = await Promise.all([
		repo.countUsers(),
		repo.countUsersCreatedSince(todayStart),
		repo.countUsersActiveSince(todayStart),
		repo.topActiveUsers(10),
		repo.countBots(),
	]);

	return {
		users: { total, todayNew, todayActive },
		topActiveUsers: topActive,
		bots: {
			total: botsTotal,
			online: getOnlineBotCount(),
		},
		version: {
			server: serverVersion,
		},
	};
}
