import assert from 'node:assert/strict';
import test from 'node:test';

import { getPluginVersion, __resetPluginVersion } from './plugin-version.js';

test('getPluginVersion should return version from package.json', async () => {
	__resetPluginVersion();
	const version = await getPluginVersion();
	assert.ok(typeof version === 'string');
	assert.ok(/^\d+\.\d+\.\d+/.test(version), `expected semver, got: ${version}`);
});

test('getPluginVersion should cache result on second call', async () => {
	__resetPluginVersion();
	const v1 = await getPluginVersion();
	const v2 = await getPluginVersion();
	assert.equal(v1, v2);
});

test('getPluginVersion should return unknown when package.json is unreadable', async () => {
	__resetPluginVersion();
	const nodeFs = await import('node:fs/promises');
	const orig = nodeFs.default.readFile;
	nodeFs.default.readFile = async () => { throw new Error('ENOENT'); };
	try {
		const v = await getPluginVersion();
		assert.equal(v, 'unknown');
	} finally {
		nodeFs.default.readFile = orig;
		__resetPluginVersion();
	}
});
