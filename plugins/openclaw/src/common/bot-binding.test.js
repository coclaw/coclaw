import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { bindBot, unbindBot } from './bot-binding.js';
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

test('bindBot should reject when already bound', async () => {
	const dir = await setupDir('coclaw-bind-dup-');
	await writeBindings(dir, { botId: 'b-exist', token: 'tk-exist' });

	try {
		await bindBot({ code: 'newcode', serverUrl: 'http://127.0.0.1:1' });
		assert.fail('should have thrown');
	} catch (err) {
		assert.match(err.message, /already bound/);
		assert.equal(err.code, 'ALREADY_BOUND');
		assert.equal(err.botId, 'b-exist');
	}
});

test('bindBot should show unknown when already bound without botId', async () => {
	const dir = await setupDir('coclaw-bind-nobot-');
	await writeBindings(dir, { token: 'tk-orphan' });

	try {
		await bindBot({ code: 'newcode', serverUrl: 'http://127.0.0.1:1' });
		assert.fail('should have thrown');
	} catch (err) {
		assert.match(err.message, /already bound/);
		assert.equal(err.code, 'ALREADY_BOUND');
		assert.equal(err.botId, undefined);
	}
});

test('unbindBot should validate token and support UNAUTHORIZED cleanup', async () => {
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await setupDir('coclaw-unbind-');
	process.env.HOME = nodePath.join(dir, 'home');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b1', token: '' });
	try {
		await assert.rejects(() => unbindBot({}), (err) => {
			assert.match(err.message, /not bound/);
			assert.equal(err.code, 'NOT_BOUND');
			return true;
		});

		await writeBindings(dir, { botId: 'b1', token: 'bad', serverUrl: 'http://127.0.0.1:1' });
		const server = await withServer(async (req, res) => {
			if (req.method === 'POST' && req.url === '/api/v1/bots/unbind') {
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
				return;
			}
			res.writeHead(404).end();
		});

		try {
			const out = await unbindBot({ serverUrl: server.baseUrl });
			assert.equal(out.alreadyServerUnbound, true);
			// bindings.json 应被删除
			const after = await readBindings(dir);
			assert.equal(after, null);
		}
		finally {
			await server.close();
		}
	}
	finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('unbindBot should throw non-UNAUTHORIZED server errors', async () => {
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await setupDir('coclaw-unbind-err-');
	process.env.HOME = nodePath.join(dir, 'home');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b1', token: 'tk' });
	const server = await withServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/unbind') {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ code: 'INTERNAL_SERVER_ERROR' }));
			return;
		}
		res.writeHead(404).end();
	});
	try {
		await assert.rejects(() => unbindBot({ serverUrl: server.baseUrl }));
	}
	finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		await server.close();
	}
});

test('bind/unbind should support env and config server url fallbacks', async () => {
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await setupDir('coclaw-fallback-');
	process.env.HOME = nodePath.join(dir, 'home');
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
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		await server.close();
	}
});
