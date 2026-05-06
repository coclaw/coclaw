import assert from 'node:assert/strict';
import test from 'node:test';

import { getClawConfig } from './claw-config.js';
import { setRuntime } from './runtime.js';

test('getClawConfig - runtime 未注入时返回 null', () => {
	setRuntime(null);
	assert.equal(getClawConfig(), null);
});

test('getClawConfig - runtime 无 config 字段时返回 null', () => {
	setRuntime({});
	try {
		assert.equal(getClawConfig(), null);
	}
	finally {
		setRuntime(null);
	}
});

test('getClawConfig - current 与 loadConfig 都缺失时返回 null', () => {
	setRuntime({ config: {} });
	try {
		assert.equal(getClawConfig(), null);
	}
	finally {
		setRuntime(null);
	}
});

test('getClawConfig - 优先使用 config.current（不触发 loadConfig 的 deprecation 警告）', () => {
	let loadConfigCalled = false;
	setRuntime({
		config: {
			current: () => ({ via: 'current' }),
			loadConfig: () => {
				loadConfigCalled = true;
				return { via: 'loadConfig' };
			},
		},
	});
	try {
		assert.deepEqual(getClawConfig(), { via: 'current' });
		assert.equal(loadConfigCalled, false);
	}
	finally {
		setRuntime(null);
	}
});

test('getClawConfig - current 缺失时回落到 loadConfig（v2026.4.26 及更早 host）', () => {
	setRuntime({
		config: {
			loadConfig: () => ({ via: 'loadConfig' }),
		},
	});
	try {
		assert.deepEqual(getClawConfig(), { via: 'loadConfig' });
	}
	finally {
		setRuntime(null);
	}
});

test('getClawConfig - reader 抛异常时不吞（让调用方按需处理）', () => {
	setRuntime({
		config: {
			current: () => { throw new Error('boom'); },
		},
	});
	try {
		assert.throws(() => getClawConfig(), /boom/);
	}
	finally {
		setRuntime(null);
	}
});
