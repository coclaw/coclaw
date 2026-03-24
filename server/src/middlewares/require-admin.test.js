import assert from 'node:assert/strict';
import test from 'node:test';

import { requireAdmin } from './require-admin.js';

function mockRes() {
	const res = {
		_status: null,
		_json: null,
		status(code) { res._status = code; return res; },
		json(body) { res._json = body; return res; },
	};
	return res;
}

test('requireAdmin: 未认证（无 isAuthenticated）返回 401', () => {
	const req = { user: null };
	const res = mockRes();
	let called = false;

	requireAdmin(req, res, () => { called = true; });

	assert.equal(res._status, 401);
	assert.equal(res._json.code, 'UNAUTHORIZED');
	assert.equal(called, false);
});

test('requireAdmin: isAuthenticated 返回 false 则 401', () => {
	const req = { isAuthenticated: () => false, user: { level: -100 } };
	const res = mockRes();
	let called = false;

	requireAdmin(req, res, () => { called = true; });

	assert.equal(res._status, 401);
	assert.equal(called, false);
});

test('requireAdmin: 非 admin 用户返回 403', () => {
	const req = { isAuthenticated: () => true, user: { level: 0 } };
	const res = mockRes();
	let called = false;

	requireAdmin(req, res, () => { called = true; });

	assert.equal(res._status, 403);
	assert.equal(res._json.code, 'FORBIDDEN');
	assert.equal(called, false);
});

test('requireAdmin: admin 用户通过', () => {
	const req = { isAuthenticated: () => true, user: { level: -100 } };
	const res = mockRes();
	let called = false;

	requireAdmin(req, res, () => { called = true; });

	assert.equal(res._status, null);
	assert.equal(called, true);
});
