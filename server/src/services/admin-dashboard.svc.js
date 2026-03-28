import { createRequire } from 'node:module';

import * as adminRepo from '../repos/admin.repo.js';
import { listOnlineBotIds } from '../bot-ws-hub.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');
// 容器环境中 plugins 目录不可用，graceful fallback
let pluginVersion = null;
try { pluginVersion = require('../../../plugins/openclaw/package.json').version; } catch {}

/**
 * @param {object} [deps] - 依赖注入
 * @param {object} [deps.repo] - admin repo
 * @param {Function} [deps.getOnlineBotCount] - 获取在线 bot 数
 * @param {Function} [deps.getOnlineBotIds] - 获取在线 bot id 集合
 */
export async function getAdminDashboard(deps = {}) {
	const repo = deps.repo ?? adminRepo;
	const getOnlineBotIds = deps.getOnlineBotIds ?? listOnlineBotIds;
	const getOnlineBotCount = deps.getOnlineBotCount ?? (() => getOnlineBotIds().size);

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [total, todayNew, todayActive, topActive, botsTotal, todayNewBots, botList] = await Promise.all([
		repo.countUsers(),
		repo.countUsersCreatedSince(todayStart),
		repo.countUsersActiveSince(todayStart),
		repo.topActiveUsers(10),
		repo.countBots(),
		repo.countBotsCreatedSince(todayStart),
		repo.listBots(50),
	]);

	const onlineIds = getOnlineBotIds();

	return {
		users: { total, todayNew, todayActive },
		topActiveUsers: topActive.map(u => ({
			...u,
			onlineBotCount: u.botIds.filter(id => onlineIds.has(String(id))).length,
		})),
		bots: {
			total: botsTotal,
			todayNew: todayNewBots,
			online: getOnlineBotCount(),
			list: botList.map(b => ({
				...b,
				isOnline: onlineIds.has(String(b.id)),
			})),
		},
		version: {
			server: serverVersion,
			plugin: pluginVersion,
		},
	};
}
