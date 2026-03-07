import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import plugin from '../index.js';
import { createMockServer } from './mock-server.helper.js';
import { setRuntime } from './runtime.js';
import { getBindingsPath, readConfig } from './config.js';

test('plugin mode: /coclaw bind and unbind should succeed', async () => {
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-tunnel-plugin-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	process.env.HOME = nodePath.join(dir, 'home');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const mock = await createMockServer();

	let handler = null;
	plugin.register({
		pluginConfig: {
			serverUrl: mock.baseUrl,
		},
		logger: { warn() {}, error() {} },
		registerChannel() {},
		registerCli() {},
		registerService() {},
		registerGatewayMethod() {},
		registerCommand(spec) {
			handler = spec.handler;
		},
	});

	assert.equal(typeof handler, 'function');

	try {
		const bindRes = await handler({ args: 'bind 12345678' });
		assert.equal(String(bindRes.text).includes('bound to CoClaw'), true);

		const bindingsPath = getBindingsPath();
		const raw = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
		assert.equal(raw.default.token, 'mock-token-1');

		const unbindRes = await handler({ args: 'unbind' });
		assert.equal(String(unbindRes.text).includes('unbound from CoClaw'), true);

		const cfg = await readConfig();
		assert.equal(cfg.token, undefined);
	}
	finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		await mock.close();
	}
});
