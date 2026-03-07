import assert from 'node:assert/strict';
import test from 'node:test';

import { getRuntime, setRuntime } from './runtime.js';

test('getRuntime returns null before setRuntime is called', () => {
	setRuntime(null);
	assert.equal(getRuntime(), null);
});

test('setRuntime / getRuntime round-trip', () => {
	const mock = { config: { loadConfig: () => ({}) } };
	setRuntime(mock);
	assert.equal(getRuntime(), mock);
	setRuntime(null);
});
