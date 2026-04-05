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
 * @param {Function} [deps.getOnlineClawCount] - 获取在线 claw 数
 */
export async function getAdminDashboard(deps = {}) {
	const repo = deps.repo ?? adminRepo;
	const getOnlineClawCount = deps.getOnlineClawCount ?? (() => listOnlineClawIds().size);

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [total, todayNew, todayActive, topActive, latestRegistered, clawsTotal] = await Promise.all([
		repo.countUsers(),
		repo.countUsersCreatedSince(todayStart),
		repo.countUsersActiveSince(todayStart),
		repo.topActiveUsers(10),
		repo.latestRegisteredUsers(30),
		repo.countClaws(),
	]);

	return {
		users: { total, todayNew, todayActive },
		topActiveUsers: topActive,
		latestRegisteredUsers: latestRegistered,
		claws: {
			total: clawsTotal,
			online: getOnlineClawCount(),
		},
		bots: {
			total: clawsTotal,
			online: getOnlineClawCount(),
		},
		version: {
			server: serverVersion,
			plugin: pluginVersion,
		},
	};
}
