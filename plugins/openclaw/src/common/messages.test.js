import assert from 'node:assert/strict';
import test from 'node:test';

import {
	notBound, bindOk, unbindOk,
	gatewayNotified, gatewayNotifyFailed,
	claimCodeCreated,
} from './messages.js';

test('bindOk should format bind success message', () => {
	assert.equal(bindOk({ botId: 'b1', rebound: false }), 'OK. Bot (b1) bound to CoClaw.');
	assert.equal(bindOk({ botId: 'b2', rebound: true }), 'OK. Bot (b2) re-bound to CoClaw.');
	assert.equal(
		bindOk({ botId: 'b2', rebound: false, previousBotId: 'b1' }),
		'OK. Bot (b2) bound to CoClaw. (previous binding to bot b1 was auto-removed)',
	);
});

test('unbindOk should format unbind success message', () => {
	assert.equal(unbindOk({ botId: 'b1' }), 'OK. Bot (b1) unbound from CoClaw.');
	assert.equal(unbindOk({}), 'OK. Bot (unknown) unbound from CoClaw.');
	assert.equal(
		unbindOk({ botId: 'b1', serverError: new Error('fetch fail') }),
		'OK. Bot (b1) unbound from CoClaw. (server notification failed; you can unbind the orphan bot in the CoClaw app)',
	);
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

test('claimCodeCreated should format claim code message', () => {
	const msg = claimCodeCreated({
		code: '12345678',
		appUrl: 'https://im.coclaw.net/claim?code=12345678',
		expiresMinutes: 30,
	});
	assert.ok(msg.includes('Claim code: 12345678'));
	assert.ok(msg.includes('https://im.coclaw.net/claim?code=12345678'));
	assert.ok(msg.includes('30 minutes'));
	assert.ok(msg.includes("don't have a CoClaw account"));
});
