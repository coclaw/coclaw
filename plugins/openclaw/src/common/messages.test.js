import assert from 'node:assert/strict';
import test from 'node:test';

import {
	notBound, bindOk, unbindOk,
	claimCodeCreated,
} from './messages.js';

test('bindOk should format bind success message', () => {
	assert.equal(bindOk({ clawId: 'b1', rebound: false }), 'OK. Claw (b1) bound to CoClaw.');
	assert.equal(bindOk({ clawId: 'b2', rebound: true }), 'OK. Claw (b2) re-bound to CoClaw.');
	assert.equal(
		bindOk({ clawId: 'b2', rebound: false, previousClawId: 'b1' }),
		'OK. Claw (b2) bound to CoClaw. (previous Claw b1 was auto-unbound)',
	);
});

test('unbindOk should format unbind success message', () => {
	assert.equal(unbindOk({ clawId: 'b1' }), 'OK. Claw (b1) unbound from CoClaw.');
	assert.equal(unbindOk({}), 'OK. Claw (unknown) unbound from CoClaw.');
});

test('notBound should return not-bound message', () => {
	assert.equal(notBound(), 'Not bound. Nothing to unbind.');
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
