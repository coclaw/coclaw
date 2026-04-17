import { createRequire } from 'node:module';

import * as adminRepo from '../repos/admin.repo.js';
import { getLatestPluginVersion } from './plugin-latest.svc.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');

/**
 * 返回 admin dashboard 快照（弱实时数据）。
 * 注意：
 * - 在线相关字段（claws.online 聚合数、latestBoundClaws[].online 布尔）**不在此返回**；
 *   在线状态由 SSE 流（/admin/stream）独立提供，前端自行订阅。
 * - `version.plugin` 字段为 npm 已发布的 @coclaw/openclaw-coclaw 最新版本号
 *   （由 plugin-latest.svc 周期轮询维护），并非本地运行环境的插件版本。
 *   缓存未就绪时为 null。
 * @param {object} [deps] - 依赖注入
 * @param {object} [deps.repo] - admin repo
 * @param {Function} [deps.getLatestPluginVersion] - 从插件版本监控服务读取最新版本
 */
export async function getAdminDashboard(deps = {}) {
	const repo = deps.repo ?? adminRepo;
	const getPluginLatest = deps.getLatestPluginVersion ?? getLatestPluginVersion;

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

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
		claws: { total: clawsTotal, todayNew: clawsTodayNew },
		topActiveUsers: topActive,
		latestRegisteredUsers: latestRegistered,
		latestBoundClaws: latestClaws,
		version: {
			server: serverVersion,
			plugin: getPluginLatest() ?? null,
		},
	};
}
