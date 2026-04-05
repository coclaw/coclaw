import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { bindClaw, unbindClaw, enrollClaw, waitForClaimAndSave } from './claw-binding.js';
import { saveHomedir, setHomedir, restoreHomedir } from '../homedir-mock.helper.js';
import { setRuntime } from '../runtime.js';

async function withServer(handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function setupDir(prefix) {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	return dir;
}

function bindingsPath(dir) {
	return nodePath.join(dir, 'coclaw', 'bindings.json');
}

async function writeBindings(dir, data) {
	const bp = bindingsPath(dir);
	await fs.mkdir(nodePath.dirname(bp), { recursive: true });
	await fs.writeFile(bp, JSON.stringify({ default: data }), 'utf8');
}

async function readBindings(dir) {
	try {
		return JSON.parse(await fs.readFile(bindingsPath(dir), 'utf8'));
	} catch (err) {
		if (err?.code === 'ENOENT') return null;
		throw err;
	}
}

test('bindClaw should validate code and write config', async () => {
	await assert.rejects(() => bindClaw({}), /binding code is required/);

	await setupDir('coclaw-bind-');

	const server = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b1', token: 't1', rebound: true }));
			return;
		}
		res.writeHead(404).end();
	});

	try {
		const out = await bindClaw({ code: '12345678', serverUrl: server.baseUrl });
		assert.equal(out.clawId, 'b1');
		assert.equal(out.rebound, true);
	}
	finally {
		await server.close();
	}
});

test('bindClaw should reject invalid server response', async () => {
	await setupDir('coclaw-bind-bad-');
	const server = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ bad: true }));
			return;
		}
		res.writeHead(404).end();
	});
	try {
		await assert.rejects(() => bindClaw({ code: '1', serverUrl: server.baseUrl }), /invalid bind response/);
	}
	finally {
		await server.close();
	}
});

test('bindClaw should rebind when already bound', async () => {
	const dir = await setupDir('coclaw-bind-rebind-');

	// 旧 server：接收 unbind 请求
	const oldUnbindCalls = [];
	const oldServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/unbind') {
			oldUnbindCalls.push(req.url);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-old' }));
			return;
		}
		res.writeHead(404).end();
	});

	// 新 server：接收 bind 请求
	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old', serverUrl: oldServer.baseUrl });

	try {
		const out = await bindClaw({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.clawId, 'b-new');
		assert.equal(out.previousClawId, 'b-old');
		assert.equal(oldUnbindCalls.length, 1);

		// 验证新绑定已写入
		const saved = await readBindings(dir);
		assert.equal(saved.default.clawId, 'b-new');
		assert.equal(saved.default.serverUrl, newServer.baseUrl);
	}
	finally {
		await oldServer.close();
		await newServer.close();
	}
});

test('bindClaw should fail when old server is unreachable (no orphan)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-noserver-');

	// 旧 serverUrl 不可达 — 强制 unbind 失败
	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old', serverUrl: 'http://127.0.0.1:1' });

	await assert.rejects(
		() => bindClaw({ code: 'newcode', serverUrl: 'http://127.0.0.1:2' }),
		(err) => {
			assert.equal(err.code, 'UNBIND_FAILED');
			assert.match(err.message, /Failed to unbind previous claw/);
			return true;
		},
	);

	// 旧绑定应保留（未被清理）
	const saved = await readBindings(dir);
	assert.equal(saved.default.clawId, 'b-old');
});

test('bindClaw should rebind when old server returns 401 (claw already gone)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-401-');

	const oldServer = await withServer(async (req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
	});

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old', serverUrl: oldServer.baseUrl });

	try {
		const out = await bindClaw({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.clawId, 'b-new');
		assert.equal(out.previousClawId, 'b-old');
	}
	finally {
		await oldServer.close();
		await newServer.close();
	}
});

test('bindClaw should rebind when old server returns 404 (claw already gone)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-404-');

	const oldServer = await withServer(async (req, res) => {
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'NOT_FOUND' }));
	});

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old', serverUrl: oldServer.baseUrl });

	try {
		const out = await bindClaw({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.clawId, 'b-new');
		assert.equal(out.previousClawId, 'b-old');
	}
	finally {
		await oldServer.close();
		await newServer.close();
	}
});

test('bindClaw should rebind when old server returns 410 (claw gone)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-410-');

	const oldServer = await withServer(async (req, res) => {
		res.writeHead(410, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'GONE' }));
	});

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old', serverUrl: oldServer.baseUrl });

	try {
		const out = await bindClaw({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.clawId, 'b-new');
		assert.equal(out.previousClawId, 'b-old');
	}
	finally {
		await oldServer.close();
		await newServer.close();
	}
});

test('bindClaw should fail when old server returns 500 (no orphan)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-500-');

	const oldServer = await withServer(async (req, res) => {
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'INTERNAL_ERROR' }));
	});

	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old', serverUrl: oldServer.baseUrl });

	try {
		await assert.rejects(
			() => bindClaw({ code: 'newcode', serverUrl: 'http://127.0.0.1:2' }),
			(err) => {
				assert.equal(err.code, 'UNBIND_FAILED');
				return true;
			},
		);

		// 旧绑定应保留
		const saved = await readBindings(dir);
		assert.equal(saved.default.clawId, 'b-old');
	}
	finally {
		await oldServer.close();
	}
});

test('bindClaw should rebind with previousClawId=unknown when old config has no clawId', async () => {
	const dir = await setupDir('coclaw-bind-rebind-noclaw-');

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		// unbind 返回 401 — claw 已不存在
		if (req.method === 'POST' && req.url === '/api/v1/claws/unbind') {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { token: 'tk-orphan', serverUrl: newServer.baseUrl });

	try {
		const out = await bindClaw({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.clawId, 'b-new');
		assert.equal(out.previousClawId, 'unknown');
	}
	finally {
		await newServer.close();
	}
});

test('bindClaw should rebind without serverUrl in old config (skip server unbind)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-nourl-');

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	// 旧绑定无 serverUrl — 跳过 server 解绑
	await writeBindings(dir, { clawId: 'b-old', token: 'tk-old' });

	try {
		const out = await bindClaw({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.clawId, 'b-new');
		assert.equal(out.previousClawId, 'b-old');
	}
	finally {
		await newServer.close();
	}
});

test('unbindClaw should throw NOT_BOUND when no token', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { clawId: 'b1', token: '' });
	try {
		await assert.rejects(() => unbindClaw({}), (err) => {
			assert.match(err.message, /not bound/);
			assert.equal(err.code, 'NOT_BOUND');
			return true;
		});
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('unbindClaw should clear config when server returns 401 (claw already gone)', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-401-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { clawId: 'b1', token: 'bad', serverUrl: 'http://127.0.0.1:1' });
	const server = await withServer(async (req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
	});

	try {
		const out = await unbindClaw({ serverUrl: server.baseUrl });
		assert.equal(out.clawId, 'b1');
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await server.close();
	}
});

test('unbindClaw should clear config when server returns 404 (claw already gone)', async () => {
	const dir = await setupDir('coclaw-unbind-404-');

	await writeBindings(dir, { clawId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' });
	const server = await withServer(async (req, res) => {
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'NOT_FOUND' }));
	});

	try {
		const out = await unbindClaw({ serverUrl: server.baseUrl });
		assert.equal(out.clawId, 'b1');
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		await server.close();
	}
});

test('unbindClaw should throw when server returns 500 (cannot confirm deletion)', async () => {
	const dir = await setupDir('coclaw-unbind-500-');

	await writeBindings(dir, { clawId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' });
	const server = await withServer(async (req, res) => {
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'INTERNAL_SERVER_ERROR' }));
	});

	try {
		await assert.rejects(
			() => unbindClaw({ serverUrl: server.baseUrl }),
			/HTTP 500/,
		);
		// 绑定应保留
		const after = await readBindings(dir);
		assert.equal(after.default.clawId, 'b1');
	}
	finally {
		await server.close();
	}
});

test('unbindClaw should throw when server is unreachable', async () => {
	const dir = await setupDir('coclaw-unbind-net-');

	await writeBindings(dir, { clawId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' });

	await assert.rejects(
		() => unbindClaw({ serverUrl: 'http://127.0.0.1:1' }),
		(err) => {
			// 网络错误没有 response
			assert.equal(err.response, undefined);
			return true;
		},
	);

	// 绑定应保留
	const after = await readBindings(dir);
	assert.equal(after.default.clawId, 'b1');
});

test('unbindClaw should clear local bindings when serverUrl is missing', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-nourl-new-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// token 存在但 serverUrl 缺失 — 跳过 server 通知，直接清理本地
	await writeBindings(dir, { clawId: 'b1', token: 'tk' });

	try {
		const out = await unbindClaw({});
		assert.equal(out.clawId, 'b1');
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('enrollClaw should reject when already bound', async () => {
	const mockReadCfg = async () => ({ token: 'existing-token', clawId: 'b1' });

	await assert.rejects(
		() => enrollClaw({ serverUrl: 'http://127.0.0.1:9999' }, { readCfg: mockReadCfg }),
		(err) => err.code === 'ALREADY_BOUND' && /unbind first/.test(err.message),
	);
});

test('enrollClaw should call createClaimCode and return claim info', async () => {
	const mockReadCfg = async () => null;
	const mockCreate = async () => ({
		code: '12345678',
		expiresAt: '2099-01-01T00:00:00.000Z',
		waitToken: 'wt-123',
	});

	const result = await enrollClaw({ serverUrl: 'http://127.0.0.1:9999' }, {
		readCfg: mockReadCfg,
		createClaimCode: mockCreate,
	});

	assert.equal(result.code, '12345678');
	assert.equal(result.waitToken, 'wt-123');
	assert.equal(result.serverUrl, 'http://127.0.0.1:9999');
	assert.equal(result.appUrl, 'http://127.0.0.1:9999/claim?code=12345678');
	assert.ok(result.expiresAt);
});

test('enrollClaw should throw on invalid server response', async () => {
	const mockReadCfg = async () => null;
	const mockCreate = async () => ({});

	await assert.rejects(
		() => enrollClaw({ serverUrl: 'http://x' }, { readCfg: mockReadCfg, createClaimCode: mockCreate }),
		/invalid enroll response/,
	);
});

test('waitForClaimAndSave should save config on BOUND response', async () => {
	let savedCfg = null;
	const mockWait = async () => ({ clawId: 'b99', token: 'tk-99' });
	const mockWrite = async (cfg) => { savedCfg = cfg; };

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c1', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite },
	);

	assert.equal(result.clawId, 'b99');
	assert.equal(savedCfg.serverUrl, 'http://127.0.0.1:8000');
	assert.equal(savedCfg.clawId, 'b99');
	assert.equal(savedCfg.token, 'tk-99');
	assert.ok(savedCfg.boundAt);
});

test('waitForClaimAndSave should retry on PENDING then resolve on BOUND', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) return { code: 'CLAIM_PENDING' };
		return { clawId: 'b100', token: 'tk-100' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c2', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.clawId, 'b100');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should retry on 408 timeout error', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) {
			const err = new Error('timeout');
			err.response = { status: 408 };
			throw err;
		}
		return { clawId: 'b101', token: 'tk-101' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c3', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.clawId, 'b101');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should retry on network error (no response)', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) {
			throw new Error('fetch failed');
		}
		return { clawId: 'b102', token: 'tk-102' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c-net', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.clawId, 'b102');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should retry on TimeoutError', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) {
			const err = new DOMException('signal timed out', 'TimeoutError');
			throw err;
		}
		return { clawId: 'b103', token: 'tk-103' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c-timeout', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.clawId, 'b103');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should retry on server 500 error', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) {
			const err = new Error('Internal Server Error');
			err.response = { status: 500 };
			throw err;
		}
		return { clawId: 'b104', token: 'tk-104' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c-500', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.clawId, 'b104');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should throw on aborted signal', async () => {
	const ac = new AbortController();
	ac.abort();
	const mockWait = async () => ({ clawId: 'b1', token: 't1' });
	const mockWrite = async () => {};

	await assert.rejects(
		() => waitForClaimAndSave(
			{ serverUrl: 'http://127.0.0.1:8000', code: 'c6', waitToken: 'wt', signal: ac.signal },
			{ waitClaimCode: mockWait, writeCfg: mockWrite },
		),
		/enroll cancelled/,
	);
});

test('waitForClaimAndSave should throw on 404 error', async () => {
	const mockWait = async () => {
		const err = new Error('not found');
		err.response = { status: 404 };
		throw err;
	};
	const mockWrite = async () => {};

	await assert.rejects(
		() => waitForClaimAndSave(
			{ serverUrl: 'http://127.0.0.1:8000', code: 'c4', waitToken: 'wt' },
			{ waitClaimCode: mockWait, writeCfg: mockWrite },
		),
		/claim code not found or expired/,
	);
});

test('waitForClaimAndSave should throw on unexpected response', async () => {
	const mockWait = async () => ({ weird: true });
	const mockWrite = async () => {};

	await assert.rejects(
		() => waitForClaimAndSave(
			{ serverUrl: 'http://127.0.0.1:8000', code: 'c5', waitToken: 'wt' },
			{ waitClaimCode: mockWait, writeCfg: mockWrite },
		),
		/unexpected claim wait response/,
	);
});

test('bind/unbind should support env and config server url fallbacks', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-fallback-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldServer = process.env.COCLAW_SERVER_URL;
	const server = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/claws/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b2', token: 't2', rebound: false }));
			return;
		}
		if (req.method === 'POST' && req.url === '/api/v1/claws/unbind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ clawId: 'b2' }));
			return;
		}
		res.writeHead(404).end();
	});
	try {
		process.env.COCLAW_SERVER_URL = server.baseUrl;
		const b = await bindClaw({ code: 'fallback-code' });
		assert.equal(b.clawId, 'b2');
		const loaded = await readBindings(dir);
		assert.equal(loaded.default.serverUrl, server.baseUrl);
		const u = await unbindClaw({});
		assert.equal(u.clawId, 'b2');
	}
	finally {
		process.env.COCLAW_SERVER_URL = oldServer;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await server.close();
	}
});
