import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { getRuntime } from './runtime.js';
import { atomicWriteJsonFile } from './utils/atomic-write.js';
import { createMutex } from './utils/mutex.js';

export const DEFAULT_ACCOUNT_ID = 'default';
const CHANNEL_ID = 'coclaw';
const BINDINGS_FILENAME = 'bindings.json';

function resolveStateDir() {
	const rt = getRuntime();
	if (rt?.state?.resolveStateDir) {
		return rt.state.resolveStateDir();
	}
	return process.env.OPENCLAW_STATE_DIR
		? nodePath.resolve(process.env.OPENCLAW_STATE_DIR)
		: nodePath.join(os.homedir(), '.openclaw');
}

export function getBindingsPath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, BINDINGS_FILENAME);
}

function toRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function readJson(filePath) {
	let raw;
	try {
		raw = await fs.readFile(filePath, 'utf8');
	}
	catch (err) {
		if (err?.code === 'ENOENT') return {};
		/* c8 ignore next 2 */
		throw err;
	}
	if (!String(raw).trim()) return {};
	try {
		return JSON.parse(raw);
	}
	catch (err) {
		// 文件损坏，删除后当空文件处理
		/* c8 ignore next -- ?./?? fallback */
		console.warn?.(`[coclaw] corrupt bindings file deleted: ${filePath} (${String(err?.message ?? err)})`);
		await fs.unlink(filePath).catch(() => {});
		return {};
	}
}

const bindingsMutex = createMutex();

// --- 公共 API ---

export async function readConfig(accountId = DEFAULT_ACCOUNT_ID) {
	const bindingsPath = getBindingsPath();
	const bindings = await readJson(bindingsPath);
	return toRecord(bindings[accountId]);
}

export async function writeConfig(nextConfig, accountId = DEFAULT_ACCOUNT_ID) {
	return bindingsMutex.withLock(async () => {
		const bindingsPath = getBindingsPath();
		const bindings = toRecord(await readJson(bindingsPath));
		const current = toRecord(bindings[accountId]);

		const next = { ...current };
		if (nextConfig.serverUrl !== undefined) next.serverUrl = nextConfig.serverUrl;
		if (nextConfig.botId !== undefined) next.botId = nextConfig.botId;
		if (nextConfig.token !== undefined) next.token = nextConfig.token;
		if (nextConfig.boundAt !== undefined) next.boundAt = nextConfig.boundAt;

		bindings[accountId] = next;
		await atomicWriteJsonFile(bindingsPath, bindings);
	});
}

export async function clearConfig(accountId = DEFAULT_ACCOUNT_ID) {
	return bindingsMutex.withLock(async () => {
		const bindingsPath = getBindingsPath();
		const bindings = toRecord(await readJson(bindingsPath));
		delete bindings[accountId];

		const remaining = Object.keys(bindings).length;
		if (remaining === 0) {
			try {
				await fs.unlink(bindingsPath);
			}
			/* c8 ignore next 4 */
			catch (err) {
				if (err?.code !== 'ENOENT') throw err;
			}
		} else {
			await atomicWriteJsonFile(bindingsPath, bindings);
		}
	});
}
