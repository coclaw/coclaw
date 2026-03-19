import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import plugin from '../index.js';
import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';
import { createMockServer } from './mock-server.helper.js';
import { setRuntime } from './runtime.js';
import { getBindingsPath, readConfig } from './config.js';

test('plugin mode: /coclaw bind and unbind should succeed', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-tunnel-plugin-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	setHomedir(nodePath.join(dir, 'home'));
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

		// enroll 斜杠命令
		const enrollRes = await handler({ args: 'enroll' });
		assert.ok(String(enrollRes.text).includes('Claim code:'));
		assert.ok(String(enrollRes.text).includes('/claim?code='));

		// 等待 fire-and-forget waitForClaimAndSave 完成（mock server 立即返回 BOUND）
		await new Promise((r) => setTimeout(r, 100));

		// 验证 enroll 写入了 config
		const cfgAfterEnroll = await readConfig();
		assert.ok(cfgAfterEnroll.token);
		assert.ok(cfgAfterEnroll.botId);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});
