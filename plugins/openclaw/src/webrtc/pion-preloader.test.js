import assert from 'node:assert/strict';
import test from 'node:test';

import { preloadPion } from './pion-preloader.js';

// --- mock helpers ---

class MockPionIpc {
	constructor(opts = {}) {
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
	await result.cleanup();
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

test('preloadPion: 不传 binPath，由 pion-node 自行解析', async () => {
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
	assert.equal(capturedOpts.binPath, undefined);
});

test('preloadPion: 意外异常时返回 null', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async () => {
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

test('preloadPion: ipc 已启动后意外异常时关闭 Go 进程', async () => {
	// 模拟 ipc.start() 成功后 log() 抛异常：
	// 注入一个在 'pion.loaded' 时抛异常的 log 函数
	let stopCalled = false;
	class TrackStopIpc extends MockPionIpc {
		async stop() { stopCalled = true; }
	}
	const logs = [];
	let callCount = 0;
	const throwingLog = (text) => {
		logs.push(text);
		callCount++;
		// 第 N 次调用抛异常（模拟 'pion.loaded' log 失败）
		// 前几次是 'pion.preload'、'pion.ipc ...' 等，最后一次是 'pion.loaded'
		if (text === 'pion.loaded') {
			throw new Error('log broke');
		}
	};
	const result = await preloadPion({
		dynamicImport: async () => ({
			PionIpc: TrackStopIpc,
			RTCPeerConnection: MockRTCPeerConnection,
		}),
		remoteLog: throwingLog,
		startTimeout: 500,
	});
	assert.equal(result, null);
	assert.ok(stopCalled, 'ipc.stop() 应被调用以关闭已启动的 Go 进程');
});
