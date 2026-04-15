import { createRequire } from 'node:module';

import * as adminRepo from '../repos/admin.repo.js';
import { listOnlineClawIds } from '../claw-ws-hub.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');
// 容器环境中 plugins 目录不可用，graceful fallback
let pluginVersion = null;
try { pluginVersion = require('../../../plugins/openclaw/package.json').version; } catch {}

/**
 * @param {object} [deps] - 依赖注入
 * @param {object} [deps.repo] - admin repo
 * @param {Function} [deps.listOnlineClawIds] - 获取在线 claw id Set
 */
export async function getAdminDashboard(deps = {}) {
	const repo = deps.repo ?? adminRepo;
	const listOnlineClawIdsImpl = deps.listOnlineClawIds ?? listOnlineClawIds;

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const onlineIds = listOnlineClawIdsImpl();

	const [
		usersTotal, usersTodayNew, usersTodayActive,
		topActive, latestRegistered,
		clawsTotal, clawsTodayNew, latestClaws,
	] = await Promise.all([
		repo.countUsers(),
		repo.countUsersCreatedSince(todayStart),
		repo.countUsersActiveSince(todayStart),
		repo.topActiveUsers(10),
		repo.latestRegisteredUsers(10),
		repo.countClaws(),
		repo.countClawsCreatedSince(todayStart),
		repo.latestBoundClaws(10),
	]);

	return {
		users: { total: usersTotal, todayNew: usersTodayNew, todayActive: usersTodayActive },
		claws: { total: clawsTotal, online: onlineIds.size, todayNew: clawsTodayNew },
		topActiveUsers: topActive,
		latestRegisteredUsers: latestRegistered,
		latestBoundClaws: latestClaws.map((c) => ({ ...c, online: onlineIds.has(c.id) })),
		version: {
			server: serverVersion,
			plugin: pluginVersion,
		},
	};
}
