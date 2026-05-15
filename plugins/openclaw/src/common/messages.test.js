import assert from 'node:assert/strict';
import test from 'node:test';

import {
	notBound, bindOk, unbindOk,
	claimCodeCreated,
	apiKeySetOk, authListEmpty, authListEntries, authRemoveOk,
} from './messages.js';

test('bindOk should format bind success message', () => {
	assert.equal(bindOk({ clawId: 'b1', rebound: false }), 'OK. Claw (b1) bound to CoClaw.');
	assert.equal(bindOk({ clawId: 'b2', rebound: true }), 'OK. Claw (b2) re-bound to CoClaw.');
	assert.equal(
		bindOk({ clawId: 'b2', rebound: false, previousClawId: 'b1' }),
		'OK. Claw (b2) bound to CoClaw. (previous Claw b1 was auto-unbound)',
	);
});

test('bindOk should tolerate undefined / empty data without throwing', () => {
	// helper "非 JSON 兜底"分支返回 {ok:true} 时 cli-registrar 传入 undefined
	assert.equal(bindOk(undefined), 'OK. Claw (unknown) bound to CoClaw.');
	assert.equal(bindOk({}), 'OK. Claw (unknown) bound to CoClaw.');
});

test('unbindOk should format unbind success message', () => {
	assert.equal(unbindOk({ clawId: 'b1' }), 'OK. Claw (b1) unbound from CoClaw.');
	assert.equal(unbindOk({}), 'OK. Claw (unknown) unbound from CoClaw.');
});

test('unbindOk should tolerate undefined data without throwing', () => {
	assert.equal(unbindOk(undefined), 'OK. Claw (unknown) unbound from CoClaw.');
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

test('apiKeySetOk should format set-api-key success', () => {
	assert.equal(
		apiKeySetOk({ provider: 'groq', profileId: 'groq:default' }),
		'OK. API key for "groq" stored (profileId=groq:default).',
	);
});

test('authListEmpty should format with and without provider filter', () => {
	assert.equal(authListEmpty(), 'No auth profiles found.');
	assert.equal(authListEmpty('groq'), 'No auth profiles found for provider "groq".');
});

test('authListEntries should render api_key entry with keyPreview', () => {
	const out = authListEntries([
		{ profileId: 'groq:default', provider: 'groq', type: 'api_key', keyPreview: 'sk-t...test' },
	]);
	assert.equal(out, 'groq:default  api_key  sk-t...test');
});

test('authListEntries should render oauth entry with email/displayName/expiresAt', () => {
	const out = authListEntries([
		{
			profileId: 'openai:default',
			provider: 'openai',
			type: 'oauth',
			email: 'a@b.com',
			displayName: 'Alice',
			expiresAt: 1700000000000,
		},
	]);
	assert.ok(out.startsWith('openai:default  oauth'));
	assert.ok(out.includes('a@b.com'));
	assert.ok(out.includes('Alice'));
	assert.ok(out.includes('expires=2023-11-14'));
});

test('authListEntries should render bare entry without meta', () => {
	const out = authListEntries([
		{ profileId: 'x:default', provider: 'x', type: 'token' },
	]);
	assert.equal(out, 'x:default  token');
});

test('authListEntries should join multiple entries with newline', () => {
	const out = authListEntries([
		{ profileId: 'a:default', provider: 'a', type: 'api_key', keyPreview: 'ak' },
		{ profileId: 'b:default', provider: 'b', type: 'api_key', keyPreview: 'bk' },
	]);
	assert.equal(out, 'a:default  api_key  ak\nb:default  api_key  bk');
});

test('authRemoveOk should format remove success', () => {
	assert.equal(authRemoveOk('groq'), 'OK. Removed all auth profiles for "groq".');
});
