import assert from 'node:assert/strict';
import test from 'node:test';

import {
	fetchLatestVersion,
	refreshLatestVersion,
	getLatestPluginVersion,
	startPolling,
	stopPolling,
	__test,
} from './plugin-latest.svc.js';

function makeSources() {
	return [
		{ name: 'npmjs', baseUrl: 'https://registry.npmjs.org/' },
		{ name: 'npmmirror', baseUrl: 'https://registry.npmmirror.com/' },
	];
}

test('fetchLatestVersion: 两源版本相同时返回同一值', async () => {
	const result = await fetchLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => '1.2.3',
	});
	assert.equal(result, '1.2.3');
});

test('fetchLatestVersion: 两源版本不同时镜像优先', async () => {
	const result = await fetchLatestVersion({
		sources: makeSources(),
		fetchFromSource: async (baseUrl) => {
			if (baseUrl.includes('npmmirror')) return '1.3.0';
			return '1.2.9';
		},
	});
	assert.equal(result, '1.3.0');
});

test('fetchLatestVersion: 仅镜像成功时返回镜像值', async () => {
	const result = await fetchLatestVersion({
		sources: makeSources(),
		fetchFromSource: async (baseUrl) => {
			if (baseUrl.includes('npmmirror')) return '1.4.0';
			throw new Error('network down');
		},
	});
	assert.equal(result, '1.4.0');
});

test('fetchLatestVersion: 仅官方成功时返回官方值', async () => {
	const result = await fetchLatestVersion({
		sources: makeSources(),
		fetchFromSource: async (baseUrl) => {
			if (baseUrl.includes('npmjs')) return '1.5.0';
			throw new Error('mirror down');
		},
	});
	assert.equal(result, '1.5.0');
});

test('fetchLatestVersion: 两源都失败时返回 null', async () => {
	const result = await fetchLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => { throw new Error('all down'); },
	});
	assert.equal(result, null);
});

test('fetchLatestVersion: timeoutMs 透传给 fetch 实现', async () => {
	let received = null;
	await fetchLatestVersion({
		sources: [{ name: 'npmjs', baseUrl: 'https://x/' }],
		timeoutMs: 1234,
		fetchFromSource: async (_url, timeoutMs) => {
			received = timeoutMs;
			return '9.9.9';
		},
	});
	assert.equal(received, 1234);
});

test('refreshLatestVersion: 成功时写缓存', async () => {
	__test.reset();
	const ver = await refreshLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => '2.0.0',
	});
	assert.equal(ver, '2.0.0');
	assert.equal(getLatestPluginVersion(), '2.0.0');
	assert.ok(__test.getState().lastFetchedAt instanceof Date);
	__test.reset();
});

test('refreshLatestVersion: 失败时保留上次缓存', async () => {
	__test.reset();
	await refreshLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => '2.1.0',
	});
	assert.equal(getLatestPluginVersion(), '2.1.0');

	const ver = await refreshLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => { throw new Error('down'); },
	});
	assert.equal(ver, null);
	assert.equal(getLatestPluginVersion(), '2.1.0'); // 保留
	__test.reset();
});

test('getLatestPluginVersion: 未拉取时返回 null', () => {
	__test.reset();
	assert.equal(getLatestPluginVersion(), null);
});

test('startPolling: 立即发起一次并按间隔持续轮询', async () => {
	__test.reset();
	let calls = 0;
	let current = '3.0.0';
	const fetchFromSource = async () => {
		calls++;
		return current;
	};

	// timer 使用了 unref；测试中需一个 ref'd 句柄保活事件循环
	const keepAlive = setTimeout(() => {}, 5_000);

	startPolling({
		intervalMs: 15,
		sources: makeSources(),
		fetchFromSource,
	});

	// 首发：等两个微任务轮结束足够
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.ok(calls >= 2, `首发应并行调用两源，实际 ${calls}`);
	assert.equal(getLatestPluginVersion(), '3.0.0');

	// 轮询：等至少一次 interval 触发（确定性轮询至 calls >= 4）
	current = '3.1.0';
	const deadline = Date.now() + 1000;
	while (calls < 4 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5));
	}
	stopPolling();
	clearTimeout(keepAlive);

	assert.ok(calls >= 4, `interval 应触发二次 fetch，实际 ${calls}`);
	assert.equal(getLatestPluginVersion(), '3.1.0');
	__test.reset();
});

test('startPolling: 重复调用先停旧定时器', () => {
	__test.reset();
	startPolling({
		intervalMs: 10_000,
		sources: makeSources(),
		fetchFromSource: async () => '4.0.0',
	});
	assert.equal(__test.getState().hasTimer, true);

	startPolling({
		intervalMs: 10_000,
		sources: makeSources(),
		fetchFromSource: async () => '4.0.0',
	});
	assert.equal(__test.getState().hasTimer, true);

	stopPolling();
	assert.equal(__test.getState().hasTimer, false);
	__test.reset();
});

test('startPolling: 首发失败时不抛', async () => {
	__test.reset();
	// 传入会 throw 的 fetch；startPolling 内部 .catch 承接后应静默
	startPolling({
		intervalMs: 10_000,
		sources: makeSources(),
		fetchFromSource: async () => { throw new Error('boom'); },
	});
	// 等一个 tick 让 promise 链执行
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(getLatestPluginVersion(), null);
	stopPolling();
	__test.reset();
});

test('stopPolling: 未启动时无副作用', () => {
	__test.reset();
	stopPolling();
	assert.equal(__test.getState().hasTimer, false);
});

test('__test.SOURCES / PKG_NAME 暴露便于断言', () => {
	assert.equal(__test.PKG_NAME, '@coclaw/openclaw-coclaw');
	assert.equal(__test.SOURCES.length, 2);
	assert.equal(__test.SOURCES[0].name, 'npmjs');
	assert.equal(__test.SOURCES[1].name, 'npmmirror');
	assert.equal(typeof __test.DEFAULT_POLL_INTERVAL_MS, 'number');
});

// 用本地 http 桩覆盖 defaultFetchFromSource（真实 axios 调用路径）
import http from 'node:http';

function startStubServer(handler) {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/` });
		});
	});
}

test('defaultFetchFromSource: 成功解析 version 字段', async () => {
	const { server, baseUrl } = await startStubServer((req, res) => {
		assert.equal(req.url, `/${__test.PKG_NAME}/latest`);
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ name: __test.PKG_NAME, version: '7.7.7' }));
	});
	try {
		const ver = await __test.defaultFetchFromSource(baseUrl, 2000);
		assert.equal(ver, '7.7.7');
	}
	finally {
		server.close();
	}
});

test('defaultFetchFromSource: 缺 version 字段时抛错', async () => {
	const { server, baseUrl } = await startStubServer((_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ name: __test.PKG_NAME }));
	});
	try {
		await assert.rejects(
			() => __test.defaultFetchFromSource(baseUrl, 2000),
			/missing version field/
		);
	}
	finally {
		server.close();
	}
});

test('defaultFetchFromSource: version 非字符串时抛错', async () => {
	const { server, baseUrl } = await startStubServer((_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ version: 123 }));
	});
	try {
		await assert.rejects(
			() => __test.defaultFetchFromSource(baseUrl, 2000),
			/missing version field/
		);
	}
	finally {
		server.close();
	}
});

test('fetchLatestVersion: 使用默认 sources（无需 deps.sources 参数）', async () => {
	const result = await fetchLatestVersion({
		fetchFromSource: async () => '6.6.6',
	});
	assert.equal(result, '6.6.6');
});

test('fetchLatestVersion: 默认 timeoutMs 路径', async () => {
	let received = null;
	await fetchLatestVersion({
		sources: [{ name: 'npmjs', baseUrl: 'https://x/' }],
		fetchFromSource: async (_url, timeoutMs) => {
			received = timeoutMs;
			return '6.6.6';
		},
	});
	assert.equal(typeof received, 'number');
	assert.ok(received > 0);
});

// ---------- P1 补充：防重入 / 日志分级 / HTTP status ----------

import { format } from 'node:util';

// 捕获 console 输出供断言（用 util.format 做 %s 替换，与 console 语义一致）
function captureConsole() {
	const origInfo = console.info;
	const origWarn = console.warn;
	const infos = [];
	const warns = [];
	console.info = (...args) => { infos.push(format(...args)); };
	console.warn = (...args) => { warns.push(format(...args)); };
	return {
		infos, warns,
		restore: () => { console.info = origInfo; console.warn = origWarn; },
	};
}

test('refreshLatestVersion: 上一轮在飞时后续调用跳过并返回当前缓存', async () => {
	__test.reset();

	// 先种入一份缓存
	await refreshLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => '5.0.0',
	});
	assert.equal(getLatestPluginVersion(), '5.0.0');

	// 第二轮：刻意 hold 住，中途发起第三轮应直接返回缓存 5.0.0
	let releaseHold;
	const hold = new Promise((r) => { releaseHold = r; });
	const slow = refreshLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => {
			await hold;
			return '5.1.0';
		},
	});
	// 让 slow 进入 await（inFlight=true）
	await new Promise((r) => setImmediate(r));
	assert.equal(__test.getState().refreshInFlight, true);

	const skipped = await refreshLatestVersion({
		sources: makeSources(),
		fetchFromSource: async () => '5.9.9', // 不应被调到
	});
	assert.equal(skipped, '5.0.0', '防重入时应返回当前缓存');

	releaseHold();
	await slow;
	assert.equal(getLatestPluginVersion(), '5.1.0');
	assert.equal(__test.getState().refreshInFlight, false);
	__test.reset();
});

test('fetchLatestVersion: 两源都失败时输出 aggregate warn', async () => {
	__test.reset();
	const cap = captureConsole();
	try {
		await fetchLatestVersion({
			sources: makeSources(),
			fetchFromSource: async () => { throw new Error('enetdown'); },
		});
	}
	finally {
		cap.restore();
	}
	const aggregate = cap.warns.find((l) => l.includes('all sources failed'));
	assert.ok(aggregate, 'aggregate warn 应存在');
	assert.ok(aggregate.includes('npmjs'));
	assert.ok(aggregate.includes('npmmirror'));
});

test('refreshLatestVersion: 首次/版本变更/未变的日志策略', async () => {
	__test.reset();
	let ver = '6.0.0';
	const deps = {
		sources: makeSources(),
		fetchFromSource: async () => ver,
	};

	// 首次
	let cap = captureConsole();
	await refreshLatestVersion(deps);
	cap.restore();
	assert.ok(cap.infos.some((l) => l.includes('initial cache: 6.0.0')));

	// 未变
	cap = captureConsole();
	await refreshLatestVersion(deps);
	cap.restore();
	assert.equal(cap.infos.length, 0, '版本未变时应静默');

	// 变更
	ver = '6.1.0';
	cap = captureConsole();
	await refreshLatestVersion(deps);
	cap.restore();
	assert.ok(cap.infos.some((l) => l.includes('version changed: 6.0.0 -> 6.1.0')));

	__test.reset();
});

test('describeFetchError: 包含 HTTP status 时前置', () => {
	assert.equal(
		__test.describeFetchError({ message: 'Request failed', response: { status: 404 } }),
		'HTTP 404 Request failed'
	);
	assert.equal(__test.describeFetchError({ message: 'timeout' }), 'timeout');
	assert.equal(__test.describeFetchError(null), 'null');
});

test('fetchLatestVersion: 镜像/官方不一致时输出 mismatch info', async () => {
	__test.reset();
	const cap = captureConsole();
	try {
		await fetchLatestVersion({
			sources: makeSources(),
			fetchFromSource: async (baseUrl) => baseUrl.includes('npmmirror') ? '7.1.0' : '7.0.0',
		});
	}
	finally {
		cap.restore();
	}
	assert.ok(cap.infos.some((l) => l.includes('version mismatch')));
});
