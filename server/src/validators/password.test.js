import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_PASSWORD_LENGTH, validatePassword } from './password.js';

test('validatePassword: should reject non-string', () => {
	const result = validatePassword(123);
	assert.equal(result.valid, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('validatePassword: should reject empty string', () => {
	const result = validatePassword('');
	assert.equal(result.valid, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('validatePassword: should reject whitespace-only string', () => {
	const result = validatePassword('   ');
	assert.equal(result.valid, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('validatePassword: should reject password shorter than minimum', () => {
	const result = validatePassword('abc');
	assert.equal(result.valid, false);
	assert.equal(result.code, 'PASSWORD_TOO_SHORT');
	assert.ok(result.message.includes(String(MIN_PASSWORD_LENGTH)));
});

test('validatePassword: should reject password of length MIN - 1', () => {
	const result = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1));
	assert.equal(result.valid, false);
	assert.equal(result.code, 'PASSWORD_TOO_SHORT');
});

test('validatePassword: should accept password of exactly minimum length', () => {
	const result = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH));
	assert.equal(result.valid, true);
});

test('validatePassword: should accept long password', () => {
	const result = validatePassword('a'.repeat(64));
	assert.equal(result.valid, true);
});

test('MIN_PASSWORD_LENGTH should be 8', () => {
	assert.equal(MIN_PASSWORD_LENGTH, 8);
});
