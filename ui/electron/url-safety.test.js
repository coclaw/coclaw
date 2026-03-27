import assert from 'node:assert/strict';
import test from 'node:test';

import { isSafeExternalUrl } from './url-safety.js';

test('isSafeExternalUrl: allows http URLs', () => {
	assert.equal(isSafeExternalUrl('http://example.com'), true);
	assert.equal(isSafeExternalUrl('http://localhost:3000/path'), true);
});

test('isSafeExternalUrl: allows https URLs', () => {
	assert.equal(isSafeExternalUrl('https://example.com'), true);
	assert.equal(isSafeExternalUrl('https://im.coclaw.net/chat'), true);
});

test('isSafeExternalUrl: blocks file:// protocol', () => {
	assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
	assert.equal(isSafeExternalUrl('file:///C:/Windows/System32'), false);
});

test('isSafeExternalUrl: blocks javascript: protocol', () => {
	assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
});

test('isSafeExternalUrl: blocks data: protocol', () => {
	assert.equal(isSafeExternalUrl('data:text/html,<h1>hi</h1>'), false);
});

test('isSafeExternalUrl: blocks ftp: protocol', () => {
	assert.equal(isSafeExternalUrl('ftp://example.com'), false);
});

test('isSafeExternalUrl: returns false for invalid URLs', () => {
	assert.equal(isSafeExternalUrl(''), false);
	assert.equal(isSafeExternalUrl('not a url'), false);
	assert.equal(isSafeExternalUrl('://missing-protocol'), false);
});

test('isSafeExternalUrl: blocks vbscript: protocol', () => {
	assert.equal(isSafeExternalUrl('vbscript:MsgBox("hi")'), false);
});

test('isSafeExternalUrl: allows uppercase protocol (URL spec normalizes)', () => {
	assert.equal(isSafeExternalUrl('HTTP://example.com'), true);
	assert.equal(isSafeExternalUrl('HTTPS://example.com'), true);
	assert.equal(isSafeExternalUrl('Https://Mixed.Case'), true);
});
