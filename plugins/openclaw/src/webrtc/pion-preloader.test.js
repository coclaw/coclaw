import assert from 'node:assert/strict';
import test from 'node:test';

import { preloadPion } from './pion-preloader.js';

// --- mock helpers ---

class MockPionIpc {
	constructor(opts = {}) {
		this.binPath = opts.binPath;
		this.logger = opts.logger;
		this.timeout = opts.timeout;
		this._started = false;
		this._stopped = false;
	}
	async start() {
		this._started = true;
	}
	async stop() {
		this._stopped = true;
	}
}

class MockRTCPeerConnection {
	constructor(config = {}) {
		this._ipc = config._ipc;
		this.iceServers = config.iceServers;
	}
}

function successDeps(overrides = {}) {
	const logs = [];
	return {
		logs,
		deps: {
			dynamicImport: async () => ({
				PionIpc: MockPionIpc,
				RTCPeerConnection: MockRTCPeerConnection,
			}),
			remoteLog: (text) => logs.push(text),
			pluginRoot: '/fake/plugin',
			binPath: '/fake/pion-ipc',
			startTimeout: 500,
			...overrides,
		},
	};
}

// --- tests ---

test('preloadPion: happy path — pion loads and starts successfully', async () => {
	const { deps, logs } = successDeps();
	const result = await preloadPion(deps);

	assert.notEqual(result, null);
	assert.equal(result.impl, 'pion');
	assert.equal(typeof result.PeerConnection, 'function');
	assert.equal(typeof result.cleanup, 'function');
	assert.ok(result.ipc instanceof MockPionIpc);
	assert.ok(result.ipc._started);
	assert.ok(logs.includes('pion.preload'));
	assert.ok(logs.includes('pion.loaded'));
});

test('preloadPion: BoundPeerConnection 自动注入 _ipc', async () => {
	const { deps } = successDeps();
	const result = await preloadPion(deps);

	const pc = new result.PeerConnection({ iceServers: [{ urls: 'stun:stun.example.com' }] });
	assert.ok(pc._ipc instanceof MockPionIpc);
	assert.equal(pc.iceServers[0].urls, 'stun:stun.example.com');
});

test('preloadPion: cleanup 调用 ipc.stop()', async () => {
	const { deps } = successDeps();
	const result = await preloadPion(deps);

	assert.ok(!result.ipc._stopped);
	await result.cleanup();
	assert.ok(result.ipc._stopped);
});

test('preloadPion: binary 不存在时返回 null', async () => {
	const origEnv = process.env.PION_IPC_BIN;
	delete process.env.PION_IPC_BIN;
	try {
		const { deps, logs } = successDeps({ binPath: undefined });
		deps.pluginRoot = '/nonexistent/path';
		const result = await preloadPion(deps);

		assert.equal(result, null);
		assert.ok(logs.some((l) => l.includes('pion.skip') && l.includes('binary-not-found')));
	} finally {
		if (origEnv === undefined) delete process.env.PION_IPC_BIN;
		else process.env.PION_IPC_BIN = origEnv;
	}
});

test('preloadPion: import 失败时返回 null', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async () => { throw new Error('module not found'); },
	});
	const result = await preloadPion(deps);

	assert.equal(result, null);
	assert.ok(logs.some((l) => l.includes('pion.skip') && l.includes('import-failed')));
});

test('preloadPion: 导出无效时返回 null', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async () => ({
			PionIpc: 'not-a-function',
			RTCPeerConnection: MockRTCPeerConnection,
		}),
	});
	const result = await preloadPion(deps);

	assert.equal(result, null);
	assert.ok(logs.some((l) => l.includes('pion.skip') && l.includes('invalid-exports')));
});

test('preloadPion: ipc.start() 失败时返回 null', async () => {
	class FailStartIpc extends MockPionIpc {
		async start() { throw new Error('spawn failed'); }
	}
	const { deps, logs } = successDeps({
		dynamicImport: async () => ({
			PionIpc: FailStartIpc,
			RTCPeerConnection: MockRTCPeerConnection,
		}),
	});
	const result = await preloadPion(deps);

	assert.equal(result, null);
	assert.ok(logs.some((l) => l.includes('pion.skip') && l.includes('start-failed')));
});

test('preloadPion: cleanup 静默忽略 stop 异常', async () => {
	class FailStopIpc extends MockPionIpc {
		async stop() { throw new Error('stop failed'); }
	}
	const { deps } = successDeps({
		dynamicImport: async () => ({
			PionIpc: FailStopIpc,
			RTCPeerConnection: MockRTCPeerConnection,
		}),
	});
	const result = await preloadPion(deps);
	// 不应 throw
	await result.cleanup();
});

test('preloadPion: PION_IPC_BIN 环境变量指向不存在文件时返回 null', async () => {
	const origEnv = process.env.PION_IPC_BIN;
	process.env.PION_IPC_BIN = '/nonexistent/pion-ipc';
	try {
		const { deps, logs } = successDeps({ binPath: undefined });
		const result = await preloadPion(deps);
		assert.equal(result, null);
		assert.ok(logs.some((l) => l.includes('pion.skip') && l.includes('binary-not-found')));
	} finally {
		if (origEnv === undefined) delete process.env.PION_IPC_BIN;
		else process.env.PION_IPC_BIN = origEnv;
	}
});

test('preloadPion: PION_IPC_BIN 指向有效文件时使用该路径', async () => {
	const origEnv = process.env.PION_IPC_BIN;
	// 用 node 可执行文件作为存在的 binary
	process.env.PION_IPC_BIN = process.execPath;
	try {
		let capturedBinPath;
		class CapturePionIpc extends MockPionIpc {
			constructor(opts = {}) {
				super(opts);
				capturedBinPath = opts.binPath;
			}
		}
		const { deps } = successDeps({
			binPath: undefined,
			dynamicImport: async () => ({
				PionIpc: CapturePionIpc,
				RTCPeerConnection: MockRTCPeerConnection,
			}),
		});
		const result = await preloadPion(deps);
		assert.notEqual(result, null);
		assert.equal(result.impl, 'pion');
		assert.equal(capturedBinPath, process.execPath);
	} finally {
		if (origEnv === undefined) delete process.env.PION_IPC_BIN;
		else process.env.PION_IPC_BIN = origEnv;
	}
});

test('preloadPion: 传递 autoRestart=true 给 PionIpc', async () => {
	let capturedOpts;
	class CapturePionIpc extends MockPionIpc {
		constructor(opts = {}) {
			super(opts);
			capturedOpts = opts;
		}
	}
	const { deps } = successDeps({
		dynamicImport: async () => ({
			PionIpc: CapturePionIpc,
			RTCPeerConnection: MockRTCPeerConnection,
		}),
	});
	const result = await preloadPion(deps);
	assert.notEqual(result, null);
	assert.equal(capturedOpts.autoRestart, true);
});

test('preloadPion: 意外异常时返回 null', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async () => {
			// 正常返回，但后续流程中抛异常
			return {
				PionIpc: class {
					constructor() { throw new Error('unexpected'); }
				},
				RTCPeerConnection: MockRTCPeerConnection,
			};
		},
	});
	const result = await preloadPion(deps);
	assert.equal(result, null);
	assert.ok(logs.some((l) => l.includes('pion.skip') && l.includes('unexpected')));
});
