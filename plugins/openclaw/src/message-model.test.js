import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOutboundEnvelope, normalizeInboundEnvelope } from './message-model.js';

test('normalizeInboundEnvelope should normalize required fields', () => {
	const envelope = normalizeInboundEnvelope({
		chatId: 'chat-1',
		senderId: 'user-1',
		text: 'hello',
	});

	assert.equal(envelope.channel, 'coclaw');
	assert.equal(envelope.chatType, 'direct');
	assert.equal(envelope.chatId, 'chat-1');
	assert.equal(envelope.senderId, 'user-1');
	assert.equal(typeof envelope.timestamp, 'number');
	assert.equal(typeof envelope.messageId, 'string');
});

test('normalizeInboundEnvelope should keep explicit fields', () => {
	const envelope = normalizeInboundEnvelope({
		channel: '  x  ',
		chatId: 'c',
		senderId: 's',
		messageId: '  m1 ',
		chatType: ' group ',
		timestamp: 123,
	});
	assert.equal(envelope.channel, 'x');
	assert.equal(envelope.messageId, 'm1');
	assert.equal(envelope.chatType, 'group');
	assert.equal(envelope.timestamp, 123);
});

test('normalizeInboundEnvelope should throw on invalid/missing fields', () => {
	assert.throws(() => normalizeInboundEnvelope(null), /must be an object/);
	assert.throws(() => normalizeInboundEnvelope({ senderId: 'u1' }), /chatId is required/);
	assert.throws(() => normalizeInboundEnvelope({ chatId: 'x' }), /senderId is required/);
});

test('buildOutboundEnvelope should normalize outbound fields', () => {
	const envelope = buildOutboundEnvelope({
		to: 'chat-1',
		text: 'pong',
	});
	assert.equal(envelope.channel, 'coclaw');
	assert.equal(envelope.to, 'chat-1');
	assert.equal(envelope.text, 'pong');
	assert.equal(typeof envelope.timestamp, 'number');
	assert.equal(typeof envelope.messageId, 'string');
});

test('buildOutboundEnvelope should keep explicit fields', () => {
	const envelope = buildOutboundEnvelope({ channel: '  y ', to: ' z ', messageId: ' id ', timestamp: 99 });
	assert.equal(envelope.channel, 'y');
	assert.equal(envelope.to, 'z');
	assert.equal(envelope.messageId, 'id');
	assert.equal(envelope.timestamp, 99);
});

test('buildOutboundEnvelope should throw on invalid input/to', () => {
	assert.throws(() => buildOutboundEnvelope(null), /must be an object/);
	assert.throws(() => buildOutboundEnvelope({ text: 'x' }), /to is required/);
});
