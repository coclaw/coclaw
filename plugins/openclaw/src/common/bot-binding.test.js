import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { bindBot, unbindBot, enrollBot, waitForClaimAndSave } from './bot-binding.js';
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

test('bindBot should validate code and write config', async () => {
	await assert.rejects(() => bindBot({}), /binding code is required/);

	await setupDir('coclaw-bind-');

	const server = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b1', token: 't1', rebound: true }));
			return;
		}
		res.writeHead(404).end();
	});

	try {
		const out = await bindBot({ code: '12345678', serverUrl: server.baseUrl });
		assert.equal(out.botId, 'b1');
		assert.equal(out.rebound, true);
	}
	finally {
		await server.close();
	}
});

test('bindBot should reject invalid server response', async () => {
	await setupDir('coclaw-bind-bad-');
	const server = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ bad: true }));
			return;
		}
		res.writeHead(404).end();
	});
	try {
		await assert.rejects(() => bindBot({ code: '1', serverUrl: server.baseUrl }), /invalid bind response/);
	}
	finally {
		await server.close();
	}
});

test('bindBot should rebind when already bound', async () => {
	const dir = await setupDir('coclaw-bind-rebind-');

	// 旧 server：接收 unbind 请求
	const oldUnbindCalls = [];
	const oldServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/unbind') {
			oldUnbindCalls.push(req.url);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b-old' }));
			return;
		}
		res.writeHead(404).end();
	});

	// 新 server：接收 bind 请求
	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { botId: 'b-old', token: 'tk-old', serverUrl: oldServer.baseUrl });

	try {
		const out = await bindBot({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.botId, 'b-new');
		assert.equal(out.previousBotId, 'b-old');
		assert.equal(oldUnbindCalls.length, 1);

		// 验证新绑定已写入
		const saved = await readBindings(dir);
		assert.equal(saved.default.botId, 'b-new');
		assert.equal(saved.default.serverUrl, newServer.baseUrl);
	}
	finally {
		await oldServer.close();
		await newServer.close();
	}
});

test('bindBot should rebind even when old server is unreachable', async () => {
	const dir = await setupDir('coclaw-bind-rebind-noserver-');

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	// 旧 serverUrl 不可达
	await writeBindings(dir, { botId: 'b-old', token: 'tk-old', serverUrl: 'http://127.0.0.1:1' });

	try {
		const out = await bindBot({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.botId, 'b-new');
		assert.equal(out.previousBotId, 'b-old');
	}
	finally {
		await newServer.close();
	}
});

test('bindBot should rebind with previousBotId=unknown when old config has no botId', async () => {
	const dir = await setupDir('coclaw-bind-rebind-nobot-');

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	await writeBindings(dir, { token: 'tk-orphan' });

	try {
		const out = await bindBot({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.botId, 'b-new');
		assert.equal(out.previousBotId, 'unknown');
	}
	finally {
		await newServer.close();
	}
});

test('bindBot should rebind without serverUrl in old config (skip server unbind)', async () => {
	const dir = await setupDir('coclaw-bind-rebind-nourl-');

	const newServer = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b-new', token: 't-new', rebound: false }));
			return;
		}
		res.writeHead(404).end();
	});

	// 旧绑定无 serverUrl — 跳过 server 解绑
	await writeBindings(dir, { botId: 'b-old', token: 'tk-old' });

	try {
		const out = await bindBot({ code: 'newcode', serverUrl: newServer.baseUrl });
		assert.equal(out.botId, 'b-new');
		assert.equal(out.previousBotId, 'b-old');
	}
	finally {
		await newServer.close();
	}
});

test('unbindBot should throw NOT_BOUND when no token', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b1', token: '' });
	try {
		await assert.rejects(() => unbindBot({}), (err) => {
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

test('unbindBot should always clear local bindings on server UNAUTHORIZED', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-401-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b1', token: 'bad', serverUrl: 'http://127.0.0.1:1' });
	const server = await withServer(async (req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
	});

	try {
		const out = await unbindBot({ serverUrl: server.baseUrl });
		assert.ok(out.serverError);
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await server.close();
	}
});

test('unbindBot should always clear local bindings on server 500', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-500-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' });
	const server = await withServer(async (req, res) => {
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'INTERNAL_SERVER_ERROR' }));
	});

	try {
		const out = await unbindBot({ serverUrl: server.baseUrl });
		assert.equal(out.botId, 'b1');
		assert.ok(out.serverError);
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await server.close();
	}
});

test('unbindBot should always clear local bindings when server is unreachable', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-net-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' });

	try {
		const out = await unbindBot({ serverUrl: 'http://127.0.0.1:1' });
		assert.equal(out.botId, 'b1');
		assert.ok(out.serverError);
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('unbindBot should clear local bindings when serverUrl is missing', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await setupDir('coclaw-unbind-nourl-new-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// token 存在但 serverUrl 缺失 — 跳过 server 通知，直接清理本地
	await writeBindings(dir, { botId: 'b1', token: 'tk' });

	try {
		const out = await unbindBot({});
		assert.equal(out.botId, 'b1');
		assert.equal(out.serverError, null);
		const after = await readBindings(dir);
		assert.equal(after, null);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('enrollBot should reject when already bound', async () => {
	const mockReadCfg = async () => ({ token: 'existing-token', botId: 'b1' });

	await assert.rejects(
		() => enrollBot({ serverUrl: 'http://127.0.0.1:9999' }, { readCfg: mockReadCfg }),
		(err) => err.code === 'ALREADY_BOUND' && /unbind first/.test(err.message),
	);
});

test('enrollBot should call createClaimCode and return claim info', async () => {
	const mockReadCfg = async () => null;
	const mockCreate = async () => ({
		code: '12345678',
		expiresAt: '2099-01-01T00:00:00.000Z',
		waitToken: 'wt-123',
	});

	const result = await enrollBot({ serverUrl: 'http://127.0.0.1:9999' }, {
		readCfg: mockReadCfg,
		createClaimCode: mockCreate,
	});

	assert.equal(result.code, '12345678');
	assert.equal(result.waitToken, 'wt-123');
	assert.equal(result.serverUrl, 'http://127.0.0.1:9999');
	assert.equal(result.appUrl, 'http://127.0.0.1:9999/claim?code=12345678');
	assert.ok(result.expiresAt);
});

test('enrollBot should throw on invalid server response', async () => {
	const mockReadCfg = async () => null;
	const mockCreate = async () => ({});

	await assert.rejects(
		() => enrollBot({ serverUrl: 'http://x' }, { readCfg: mockReadCfg, createClaimCode: mockCreate }),
		/invalid enroll response/,
	);
});

test('waitForClaimAndSave should save config on BOUND response', async () => {
	let savedCfg = null;
	const mockWait = async () => ({ botId: 'b99', token: 'tk-99' });
	const mockWrite = async (cfg) => { savedCfg = cfg; };

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c1', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite },
	);

	assert.equal(result.botId, 'b99');
	assert.equal(savedCfg.serverUrl, 'http://127.0.0.1:8000');
	assert.equal(savedCfg.botId, 'b99');
	assert.equal(savedCfg.token, 'tk-99');
	assert.ok(savedCfg.boundAt);
});

test('waitForClaimAndSave should retry on PENDING then resolve on BOUND', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) return { code: 'CLAIM_PENDING' };
		return { botId: 'b100', token: 'tk-100' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c2', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.botId, 'b100');
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
		return { botId: 'b101', token: 'tk-101' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c3', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.botId, 'b101');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should retry on network error (no response)', async () => {
	let callCount = 0;
	const mockWait = async () => {
		callCount += 1;
		if (callCount === 1) {
			throw new Error('fetch failed');
		}
		return { botId: 'b102', token: 'tk-102' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c-net', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.botId, 'b102');
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
		return { botId: 'b103', token: 'tk-103' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c-timeout', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.botId, 'b103');
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
		return { botId: 'b104', token: 'tk-104' };
	};
	const mockWrite = async () => {};

	const result = await waitForClaimAndSave(
		{ serverUrl: 'http://127.0.0.1:8000', code: 'c-500', waitToken: 'wt' },
		{ waitClaimCode: mockWait, writeCfg: mockWrite, retryDelayMs: 0 },
	);

	assert.equal(result.botId, 'b104');
	assert.equal(callCount, 2);
});

test('waitForClaimAndSave should throw on aborted signal', async () => {
	const ac = new AbortController();
	ac.abort();
	const mockWait = async () => ({ botId: 'b1', token: 't1' });
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
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b2', token: 't2', rebound: false }));
			return;
		}
		if (req.method === 'POST' && req.url === '/api/v1/bots/unbind') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: 'b2' }));
			return;
		}
		res.writeHead(404).end();
	});
	try {
		process.env.COCLAW_SERVER_URL = server.baseUrl;
		const b = await bindBot({ code: 'fallback-code' });
		assert.equal(b.botId, 'b2');
		const loaded = await readBindings(dir);
		assert.equal(loaded.default.serverUrl, server.baseUrl);
		const u = await unbindBot({});
		assert.equal(u.botId, 'b2');
	}
	finally {
		process.env.COCLAW_SERVER_URL = oldServer;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await server.close();
	}
});

