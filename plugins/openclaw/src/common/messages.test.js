import assert from 'node:assert/strict';
import test from 'node:test';

import {
	alreadyBound, notBound, bindOk, unbindOk,
	gatewayNotified, gatewayNotifyFailed,
} from './messages.js';

test('bindOk should format bind success message', () => {
	assert.equal(bindOk({ botId: 'b1', rebound: false }), 'OK. Bot (b1) bound to CoClaw.');
	assert.equal(bindOk({ botId: 'b2', rebound: true }), 'OK. Bot (b2) re-bound to CoClaw.');
});

test('unbindOk should format unbind success message', () => {
	assert.equal(unbindOk({ botId: 'b1' }), 'OK. Bot (b1) unbound from CoClaw.');
	assert.equal(unbindOk({}), 'OK. Bot (unknown) unbound from CoClaw.');
	assert.equal(
		unbindOk({ botId: 'b1', serverError: new Error('fetch fail') }),
		'OK. Bot (b1) unbound from CoClaw. (server notification failed; you can unbind the orphan bot in the CoClaw app)',
	);
});

test('alreadyBound should format already-bound error message', () => {
	assert.equal(alreadyBound({ botId: 'b1' }), 'Already bound to CoClaw as bot (b1).\nRun `openclaw coclaw unbind` to unbind first.');
	assert.equal(alreadyBound({}), 'Already bound to CoClaw as bot (unknown).\nRun `openclaw coclaw unbind` to unbind first.');
});

test('notBound should return not-bound message', () => {
	assert.equal(notBound(), 'Not bound. Nothing to unbind.');
});

test('gatewayNotified should return action-specific message', () => {
	assert.equal(gatewayNotified('refresh'), 'Bridge connection refreshed.');
	assert.equal(gatewayNotified('stop'), 'Bridge connection stopped.');
});

test('gatewayNotifyFailed should return warning message', () => {
	assert.ok(gatewayNotifyFailed().includes('could not notify'));
});
