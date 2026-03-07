import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveErrorMessage } from './errors.js';

test('resolveErrorMessage should cover known/unknown/fallback branches', () => {
	const known = resolveErrorMessage({ response: { data: { code: 'UNAUTHORIZED' } } });
	assert.equal(known.includes('UNAUTHORIZED'), true);

	const msgOnly = resolveErrorMessage({ response: { data: { message: 'bad req' } } });
	assert.equal(msgOnly, 'bad req');

	const withCode = resolveErrorMessage({ response: { data: { code: 'X', message: 'oops' } } });
	assert.equal(withCode, 'oops (X)');

	const err = resolveErrorMessage(new Error('boom'));
	assert.equal(err, 'boom');

	const fallback = resolveErrorMessage(null, 'fallback-text');
	assert.equal(fallback, 'fallback-text');
});
