import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGetInfo, version } from './info.route.js';

function createRes() {
	return {
		body: null,
		json(payload) {
			this.body = payload;
			return this;
		},
	};
}

test('version should be a non-empty string from package.json', () => {
	assert.equal(typeof version, 'string');
	assert.ok(version.length > 0);
	assert.notEqual(version, 'unknown');
});

test('handleGetInfo: should return { version }', () => {
	const res = createRes();
	handleGetInfo({}, res, () => {});
	assert.deepEqual(res.body, { version });
});

test('handleGetInfo: res.json 抛异常时调用 next(err)', () => {
	const err = new Error('json failed');
	const res = {
		json() { throw err; },
	};
	let nextErr = null;
	handleGetInfo({}, res, (e) => { nextErr = e; });
	assert.equal(nextErr, err);
});
