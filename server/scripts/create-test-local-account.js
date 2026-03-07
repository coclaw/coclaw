import { prisma } from '../src/db/prisma.js';
import { findLocalAuthByLoginName } from '../src/repos/local-auth.repo.js';
import { createLocalAccount } from '../src/services/local-auth.svc.js';

const TEST_LOGIN_NAME = 'test';
const TEST_PASSWORD = '123456';

async function main() {
	const existing = await findLocalAuthByLoginName(TEST_LOGIN_NAME);
	if (existing) {
		console.log(
			`Local test account already exists: loginName=${TEST_LOGIN_NAME}, userId=${existing.userId.toString()}`,
		);
		return;
	}

	const created = await createLocalAccount({
		loginName: TEST_LOGIN_NAME,
		password: TEST_PASSWORD,
	});

	console.log(
		`Local test account created: loginName=${TEST_LOGIN_NAME}, userId=${created.id.toString()}`,
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
