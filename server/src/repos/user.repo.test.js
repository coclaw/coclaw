import assert from 'node:assert/strict';
import test from 'node:test';

import { touchUserLogout } from './user.repo.js';

test('touchUserLogout: 调用 db.user.update 并传入正确参数', async () => {
	const userId = 42n;
	let captured = null;
	const db = {
		user: {
			update: async (args) => { captured = args; },
		},
	};

	await touchUserLogout(userId, db);

	assert.equal(captured.where.id, userId);
	assert.ok(captured.data.lastLogoutAt instanceof Date);
});
