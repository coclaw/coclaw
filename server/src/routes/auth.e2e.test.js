import 'dotenv/config';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import request from 'supertest';

import { prisma } from '../db/prisma.js';
import { createApp } from '../app.js';

const app = createApp();
const createdUserIds = [];

function genLoginName() {
	return `e2e_u_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
}

before(async () => {
	await prisma.$executeRawUnsafe(`
		CREATE TABLE IF NOT EXISTS \`UserSetting\` (
			\`userId\` BIGINT UNSIGNED NOT NULL,
			\`theme\` VARCHAR(32) NULL,
			\`lang\` VARCHAR(10) NULL,
			\`perfs\` JSON NOT NULL DEFAULT (JSON_OBJECT()),
			\`uiState\` JSON NOT NULL DEFAULT (JSON_OBJECT()),
			\`hintCounts\` JSON NOT NULL DEFAULT (JSON_OBJECT()),
			\`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
			PRIMARY KEY (\`userId\`),
			CONSTRAINT \`UserSetting_userId_fkey\`
				FOREIGN KEY (\`userId\`) REFERENCES \`User\`(\`id\`)
				ON DELETE CASCADE ON UPDATE CASCADE
		)
	`);
	await prisma.$executeRawUnsafe(`
		CREATE TABLE IF NOT EXISTS \`ExpressSession\` (
			\`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
			\`sid\` VARCHAR(128) NOT NULL,
			\`data\` MEDIUMTEXT NOT NULL,
			\`expiresAt\` DATETIME(3) NOT NULL,
			PRIMARY KEY (\`id\`),
			UNIQUE INDEX \`ExpressSession_sid_key\`(\`sid\`),
			INDEX \`ExpressSession_expiresAt_idx\`(\`expiresAt\`)
		)
	`);
});

after(async () => {
	await prisma.expressSession.deleteMany().catch(() => {});
	for (const userId of createdUserIds) {
		await prisma.user.delete({
			where: { id: userId },
		}).catch(() => {});
	}
	await prisma.$disconnect();
});

test('e2e: GET /api/v1/auth/session should return null when user is not logged in', async () => {
	const agent = request.agent(app);
	const res = await agent.get('/api/v1/auth/session');

	assert.equal(res.status, 200);
	assert.deepEqual(res.body, {
		user: null,
	});
});

test('e2e: register → login → session → logout should work end-to-end', async () => {
	const agent = request.agent(app);
	const loginName = genLoginName();
	const password = 'P@ssw0rd_for_e2e_case';

	// 注册
	const regRes = await agent
		.post('/api/v1/auth/local/register')
		.send({ loginName, password });

	assert.equal(regRes.status, 201);
	const userId = regRes.body?.user?.id;
	assert.ok(userId);
	assert.equal(regRes.body.user.authType, 'local');
	assert.equal(regRes.body.user.auth?.local?.loginName, loginName);
	createdUserIds.push(BigInt(userId));

	// 注册后自动登录，session 应包含用户
	const sessionAfterReg = await agent.get('/api/v1/auth/session');
	assert.equal(sessionAfterReg.status, 200);
	assert.equal(sessionAfterReg.body?.user?.id, userId);

	// 重复 loginName 注册应 409
	const dupRes = await request(app)
		.post('/api/v1/auth/local/register')
		.send({ loginName, password });
	assert.equal(dupRes.status, 409);
	assert.equal(dupRes.body.code, 'LOGIN_NAME_TAKEN');

	// 登出
	const logoutRes = await agent.post('/api/v1/auth/logout');
	assert.equal(logoutRes.status, 204);

	// 登出后 session 应为空
	const sessionAfterLogout = await agent.get('/api/v1/auth/session');
	assert.equal(sessionAfterLogout.status, 200);
	assert.deepEqual(sessionAfterLogout.body, { user: null });

	// 重新登录验证密码持久化
	const loginRes = await agent
		.post('/api/v1/auth/local/login')
		.send({ loginName, password });

	assert.equal(loginRes.status, 200);
	assert.equal(loginRes.body?.user?.id, userId);

	const sessionRes = await agent.get('/api/v1/auth/session');
	assert.equal(sessionRes.status, 200);
	assert.equal(sessionRes.body?.user?.id, userId);
});
