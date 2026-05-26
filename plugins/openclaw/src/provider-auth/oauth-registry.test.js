import assert from 'node:assert/strict';
import test from 'node:test';

import { registerLogin, getLogin, removeLogin, __resetRegistry } from './oauth-registry.js';

test('register → get returns the same entry', () => {
	__resetRegistry();
	const ac = new AbortController();
	registerLogin('L1', { abortController: ac });
	assert.equal(getLogin('L1').abortController, ac);
	__resetRegistry();
});

test('get unknown loginId returns undefined', () => {
	__resetRegistry();
	assert.equal(getLogin('missing'), undefined);
});

test('removeLogin drops the entry; subsequent get is undefined', () => {
	__resetRegistry();
	registerLogin('L2', { abortController: new AbortController() });
	removeLogin('L2');
	assert.equal(getLogin('L2'), undefined);
	__resetRegistry();
});

test('removeLogin on unknown loginId is a no-op (no throw)', () => {
	__resetRegistry();
	assert.doesNotThrow(() => removeLogin('never'));
});

test('__resetRegistry clears all entries', () => {
	registerLogin('A', { abortController: new AbortController() });
	registerLogin('B', { abortController: new AbortController() });
	__resetRegistry();
	assert.equal(getLogin('A'), undefined);
	assert.equal(getLogin('B'), undefined);
});
