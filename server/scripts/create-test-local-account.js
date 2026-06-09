import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { findLocalAuthByLoginName, createLocalUserByLoginName } from '../src/repos/local-auth.repo.js';
import { genUserId } from '../src/services/id.svc.js';
import { scrypt } from '../src/utils/scrypt-password.js';

const TEST_LOGIN_NAME = 'test';
const TEST_PASSWORD = '12345678';

// 测试专用引导：本地 E2E / 开发用的 test 账号。
// loginName 'test' 命中注册保留名校验，故这里不走 createLocalAccount（会被 validateLoginName 拒），
// 而是复用真实哈希 + ID 生成、经 repo 直接播种——产出与正常本地账号完全等价。仅供测试环境使用。
async function main() {
	const existing = await findLocalAuthByLoginName(TEST_LOGIN_NAME);
	if (existing) {
		console.log(
			`Local test account already exists: loginName=${TEST_LOGIN_NAME}, userId=${existing.userId.toString()}`,
		);
		return;
	}

	const userId = genUserId();
	const passwordHash = await scrypt.hashPassword(TEST_PASSWORD);
	await createLocalUserByLoginName({ userId, loginName: TEST_LOGIN_NAME, passwordHash });

	const created = await findLocalAuthByLoginName(TEST_LOGIN_NAME);
	console.log(
		`Local test account created: loginName=${TEST_LOGIN_NAME}, userId=${created.userId.toString()}`,
	);
}

main()
	.catch((err) => {
		console.error('Failed to create local test account:', err);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
