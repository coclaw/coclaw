import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransportAdapter } from './transport-adapter.js';

test('createTransportAdapter should dispatch inbound/outbound', async () => {
	const calls = {
		inbound: 0,
		outbound: 0,
	};

	const adapter = createTransportAdapter({
		onInbound: async () => {
			calls.inbound += 1;
		},
		sendOutbound: async () => {
			calls.outbound += 1;
			return { accepted: true };
		},
	});

	await adapter.dispatchInbound({
		chatId: 'c1',
		senderId: 'u1',
		text: 'hello',
	});
	const outbound = await adapter.dispatchOutbound({
		to: 'c1',
		text: 'world',
	});

	assert.equal(calls.inbound, 1);
	assert.equal(calls.outbound, 1);
	assert.equal(outbound.accepted, true);
});

test('createTransportAdapter safe wrappers should swallow errors', async () => {
	const adapter = createTransportAdapter({
		onInbound: async () => {
			throw 'bad inbound';
		},
		sendOutbound: async () => {
			throw new Error('bad outbound');
		},
		logger: { warn() {} },
	});

	const inbound = await adapter.safeDispatchInbound({
		chatId: 'c1',
		senderId: 'u1',
	});
	const outbound = await adapter.safeDispatchOutbound({
		to: 'c1',
	});

	assert.equal(inbound, null);
	assert.equal(outbound.accepted, false);
});

test('createTransportAdapter should use default deps and normalize accepted', async () => {
	const adapter = createTransportAdapter({
		sendOutbound: async () => ({}),
	});
	const out = await adapter.dispatchOutbound({ to: 'x', text: 'y' });
	assert.equal(out.accepted, true);

	const defaults = createTransportAdapter();
	const inbound = await defaults.dispatchInbound({ chatId: 'c2', senderId: 'u2' });
	assert.equal(inbound.chatId, 'c2');

	const noWarn = createTransportAdapter({
		onInbound: async () => {
			throw new Error('x');
		},
		logger: {},
	});
	const v = await noWarn.safeDispatchInbound({ chatId: 'c3', senderId: 'u3' });
	assert.equal(v, null);
});
