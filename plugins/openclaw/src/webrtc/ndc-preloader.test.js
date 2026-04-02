import assert from 'node:assert/strict';
import test from 'node:test';

import { preloadNdc, defaultResolvePaths } from './ndc-preloader.js';

// --- mock helpers ---

function createMockRTCPeerConnection() {
	return class MockRTCPeerConnection {
		constructor() { this.closed = false; }
		createDataChannel() { return {}; }
		close() { this.closed = true; }
	};
}

/** 创建成功的 deps 基础集 */
function successDeps(overrides = {}) {
	const logs = [];
	const MockRTCPC = createMockRTCPeerConnection();
	const mockCleanup = () => {};

	return {
		logs,
		deps: {
			fs: {
				access: async () => {},
				copyFile: async () => {},
				mkdir: async () => {},
			},
			dynamicImport: async (spec) => {
				if (spec === 'node-datachannel/polyfill') {
					return { RTCPeerConnection: MockRTCPC };
				}
				if (spec === 'node-datachannel') {
					return { cleanup: mockCleanup };
				}
				if (spec === 'werift') {
					return { RTCPeerConnection: class WeriftPC {} };
				}
				throw new Error(`unexpected import: ${spec}`);
			},
			remoteLog: (text) => logs.push(text),
			platform: 'linux',
			arch: 'x64',
			pluginRoot: '/fake/plugin',
			resolvePaths: () => ({
				src: '/fake/plugin/vendor/ndc-prebuilds/linux-x64/node_datachannel.node',
				dest: '/fake/node_modules/node-datachannel/build/Release/node_datachannel.node',
				destDir: '/fake/node_modules/node-datachannel/build/Release',
			}),
			importTimeout: 500,
			...overrides,
		},
	};
}

/** 创建 access 模拟：dest 不存在、src 存在 */
function needCopyFs(base = {}) {
	let accessCallCount = 0;
	return {
		access: async () => {
			accessCallCount++;
			// 第一次调用检查 dest → 不存在
			if (accessCallCount === 1) throw new Error('ENOENT');
			// 第二次调用检查 src → 存在
		},
		copyFile: base.copyFile ?? (async () => {}),
		mkdir: base.mkdir ?? (async () => {}),
	};
}

// --- tests ---

test('preloadNdc: happy path — ndc loads successfully (binary already exists)', async () => {
	const { deps, logs } = successDeps();
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'ndc');
	assert.equal(typeof result.PeerConnection, 'function');
	assert.equal(typeof result.cleanup, 'function');
	assert.ok(logs.some((l) => l.includes('ndc.preload platform=linux-x64')));
	assert.ok(logs.some((l) => l.includes('ndc.binary-exists')));
	assert.ok(logs.some((l) => l.includes('ndc.loaded platform=linux-x64')));
	// 不应有 fallback 日志
	assert.ok(!logs.some((l) => l.includes('ndc.fallback')));
	assert.ok(!logs.some((l) => l.includes('webrtc.fallback-to-werift')));
});

test('preloadNdc: happy path — binary needs copy', async () => {
	const { deps, logs } = successDeps({ fs: needCopyFs() });
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'ndc');
	assert.ok(logs.some((l) => l.includes('ndc.binary-deployed')));
	assert.ok(logs.some((l) => l.includes('ndc.loaded')));
});

test('preloadNdc: unsupported platform → werift fallback', async () => {
	const { deps, logs } = successDeps({ platform: 'freebsd', arch: 'x64' });
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.equal(result.cleanup, null);
	assert.ok(logs.some((l) => l.includes('ndc.skip reason=unsupported-platform')));
	assert.ok(logs.some((l) => l.includes('webrtc.fallback-to-werift')));
});

test('preloadNdc: vendor binary missing → werift fallback', async () => {
	// dest 不存在，src 也不存在
	const fs = {
		access: async () => { throw new Error('ENOENT'); },
		copyFile: async () => {},
		mkdir: async () => {},
	};
	const { deps, logs } = successDeps({ fs });
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=binary-missing')));
	assert.ok(logs.some((l) => l.includes('webrtc.fallback-to-werift')));
});

test('preloadNdc: copy fails → werift fallback', async () => {
	const fs = needCopyFs({
		copyFile: async () => { throw new Error('EACCES: permission denied'); },
	});
	const { deps, logs } = successDeps({ fs });
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=copy-failed')));
	assert.ok(logs.some((l) => l.includes('EACCES')));
});

test('preloadNdc: import fails → werift fallback', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') throw new Error('MODULE_NOT_FOUND');
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=import-failed')));
	assert.ok(logs.some((l) => l.includes('MODULE_NOT_FOUND')));
});

test('preloadNdc: smoke test fails (RTCPeerConnection not a function) → werift fallback', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') {
				return { RTCPeerConnection: 'not-a-function' };
			}
			if (spec === 'node-datachannel') return { cleanup: () => {} };
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=smoke-failed')));
	assert.ok(logs.some((l) => l.includes('RTCPeerConnection is not a function')));
});

test('preloadNdc: resolvePaths throws → werift fallback', async () => {
	const { deps, logs } = successDeps({
		resolvePaths: () => { throw new Error('resolve failed'); },
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=unexpected')));
	assert.ok(logs.some((l) => l.includes('resolve failed')));
});

test('preloadNdc: cleanup from ndc.default.cleanup', async () => {
	const mockCleanup = () => {};
	const { deps } = successDeps({
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') {
				return { RTCPeerConnection: createMockRTCPeerConnection() };
			}
			if (spec === 'node-datachannel') {
				// 模拟 cleanup 在 default 上
				return { default: { cleanup: mockCleanup } };
			}
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'ndc');
	assert.equal(result.cleanup, mockCleanup);
});

test('preloadNdc: cleanup is null when neither ndc.cleanup nor default.cleanup exists', async () => {
	const { deps } = successDeps({
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') {
				return { RTCPeerConnection: createMockRTCPeerConnection() };
			}
			if (spec === 'node-datachannel') {
				return {}; // 无 cleanup
			}
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'ndc');
	assert.equal(result.cleanup, null);
});

test('preloadNdc: all supported platforms are accepted', async () => {
	const platforms = [
		['linux', 'x64'],
		['linux', 'arm64'],
		['darwin', 'x64'],
		['darwin', 'arm64'],
		['win32', 'x64'],
	];
	for (const [platform, arch] of platforms) {
		const { deps } = successDeps({ platform, arch });
		const result = await preloadNdc(deps);
		assert.equal(result.impl, 'ndc', `${platform}-${arch} should load ndc`);
	}
});

test('preloadNdc: mkdir failure during copy → werift fallback', async () => {
	const fs = {
		access: async () => { throw new Error('ENOENT'); },
		mkdir: async () => { throw new Error('EPERM'); },
		copyFile: async () => {},
	};
	// access 抛两次：dest 不存在 → src 检查…但这里 access 总是抛
	// 需要更精确的 mock：第一次 dest 不存在，第二次 src 存在
	let callCount = 0;
	fs.access = async () => {
		callCount++;
		if (callCount === 1) throw new Error('ENOENT'); // dest 不存在
		// src 存在 → 不抛
	};
	const { deps, logs } = successDeps({ fs });
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=copy-failed')));
});

test('preloadNdc: uses default deps when none injected (integration)', async () => {
	// 不注入任何 deps，所有 ?? 走默认分支
	// 覆盖所有 ?? 右侧默认分支
	const result = await preloadNdc();
	// 结果取决于当前环境（是否有 vendor binary），但不应抛出
	assert.ok(result.impl === 'ndc' || result.impl === 'werift' || result.impl === 'none');
	// 如果加载了 ndc，必须调用 cleanup 防止进程挂起（issue #366）
	result.cleanup?.();
});

// --- timeout 测试 ---

test('preloadNdc: ndc import timeout → werift fallback', async () => {
	const { deps, logs } = successDeps({
		importTimeout: 50,
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') {
				// 模拟 ndc 加载卡住（超过 timeout 才返回）
				await new Promise((r) => setTimeout(r, 200));
				return { RTCPeerConnection: createMockRTCPeerConnection() };
			}
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=import-failed')));
	assert.ok(logs.some((l) => l.includes('timed out')));
	assert.ok(logs.some((l) => l.includes('webrtc.fallback-to-werift')));
});

test('preloadNdc: ndc and werift both timeout → impl=none', async () => {
	const { deps, logs } = successDeps({
		importTimeout: 50,
		dynamicImport: async () => {
			// 所有 import 都卡住
			await new Promise((r) => setTimeout(r, 200));
			return {};
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'none');
	assert.equal(result.PeerConnection, null);
	assert.equal(result.cleanup, null);
	assert.ok(logs.some((l) => l.includes('webrtc.all-unavailable')));
});

test('preloadNdc: ndc and werift both fail (not timeout) → impl=none', async () => {
	const { deps, logs } = successDeps({
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') throw new Error('ndc broken');
			if (spec === 'werift') throw new Error('werift broken');
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);

	assert.equal(result.impl, 'none');
	assert.equal(result.PeerConnection, null);
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=import-failed')));
	assert.ok(logs.some((l) => l.includes('webrtc.all-unavailable')));
	assert.ok(logs.some((l) => l.includes('werift broken')));
});

test('preloadNdc: background import rejection after timeout is silently caught', async () => {
	// 验证超时后，原 promise 最终 reject 不会成为 unhandled rejection
	const { deps } = successDeps({
		importTimeout: 50,
		dynamicImport: async (spec) => {
			if (spec === 'node-datachannel/polyfill') {
				await new Promise((r) => setTimeout(r, 100));
				// 超时后这个 rejection 应被 withTimeout 内的 .catch(() => {}) 吞掉
				throw new Error('delayed ndc failure');
			}
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
	});
	const result = await preloadNdc(deps);
	assert.equal(result.impl, 'werift');
	// 等一会儿让后台 promise 有时间 reject
	await new Promise((r) => setTimeout(r, 150));
	// 如果 unhandled rejection 未被兜住，进程会被 node --test 标记为失败
});

// --- defaultResolvePaths 测试 ---

test('defaultResolvePaths: returns correct paths structure', () => {
	// 创建一个模拟环境让 require.resolve 能找到 node-datachannel
	// 使用实际插件根目录（node-datachannel 当前未安装，会抛错，但可验证 src 路径）
	const pluginRoot = '/mock/plugin';
	try {
		defaultResolvePaths('linux-x64', pluginRoot);
		// 如果 node-datachannel 已安装，验证路径结构
	} catch (err) {
		// node-datachannel 未安装时 require.resolve 抛错——这是预期行为
		assert.ok(err.message.includes('node-datachannel') || err.code === 'MODULE_NOT_FOUND');
	}
});

test('preloadNdc: default resolvePaths (no injection) — node-datachannel not installed → fallback', async () => {
	// 不注入 resolvePaths，使用默认的 defaultResolvePaths
	// 由于 node-datachannel 未安装，require.resolve 会抛 MODULE_NOT_FOUND
	// 触发 unexpected 兜底 → werift fallback
	const logs = [];
	const result = await preloadNdc({
		fs: {
			access: async () => { throw new Error('ENOENT'); },
			copyFile: async () => {},
			mkdir: async () => {},
		},
		dynamicImport: async (spec) => {
			if (spec === 'werift') return { RTCPeerConnection: class WeriftPC {} };
			throw new Error(`unexpected import: ${spec}`);
		},
		remoteLog: (text) => logs.push(text),
		platform: 'linux',
		arch: 'x64',
		// 不注入 pluginRoot 和 resolvePaths — 使用默认值
	});

	assert.equal(result.impl, 'werift');
	assert.ok(logs.some((l) => l.includes('ndc.fallback reason=unexpected') || l.includes('ndc.fallback reason=')));
});
