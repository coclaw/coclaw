import assert from 'node:assert/strict';
import test from 'node:test';

import { coclawChannelPlugin } from './channel-plugin.js';

test('coclawChannelPlugin should expose required channel fields', () => {
	assert.equal(coclawChannelPlugin.id, 'coclaw');
	assert.equal(typeof coclawChannelPlugin.meta.label, 'string');
	assert.equal(Array.isArray(coclawChannelPlugin.capabilities.chatTypes), true);
	assert.equal(typeof coclawChannelPlugin.config.listAccountIds, 'function');
	assert.equal(typeof coclawChannelPlugin.config.resolveAccount, 'function');
	assert.equal(typeof coclawChannelPlugin.outbound.sendText, 'function');
});

test('coclawChannelPlugin config should resolve account with defaults', () => {
	const account = coclawChannelPlugin.config.resolveAccount({}, undefined);
	assert.equal(account.accountId, 'default');
	assert.equal(account.enabled, true);
	assert.equal(account.name, 'CoClaw');

	const account2 = coclawChannelPlugin.config.resolveAccount({}, 'custom');
	assert.equal(account2.accountId, 'custom');
	assert.equal(account2.enabled, true);
	assert.equal(account2.name, 'CoClaw');

	const desc = coclawChannelPlugin.config.describeAccount(account2);
	assert.equal(desc.configured, true);
	assert.equal(coclawChannelPlugin.config.isConfigured(), true);
	assert.deepEqual(coclawChannelPlugin.config.listAccountIds(), ['default']);
	assert.equal(coclawChannelPlugin.config.defaultAccountId(), 'default');
});

test('coclawChannelPlugin outbound sendText should return channel result', async () => {
	const out = await coclawChannelPlugin.outbound.sendText({ to: 'chat-1', text: 'hello' });
	assert.equal(out.channel, 'coclaw');
	assert.equal(typeof out.messageId, 'string');
	assert.equal(out.to, 'chat-1');
});
