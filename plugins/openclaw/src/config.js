import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { getRuntime } from './runtime.js';

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
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		if (!String(raw).trim()) {
			return {};
		}
		return JSON.parse(raw);
	}
	catch (err) {
		if (err?.code === 'ENOENT') {
			return {};
		}
		throw err;
	}
}

async function writeJson(filePath, value) {
	const dirPath = nodePath.dirname(filePath);
	await fs.mkdir(dirPath, { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// --- 旧位置迁移 ---

function getOpenclawConfigPath() {
	return process.env.OPENCLAW_CONFIG_PATH
		? nodePath.resolve(process.env.OPENCLAW_CONFIG_PATH)
		: nodePath.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function pickFromOldConfig(rootCfg) {
	const channels = toRecord(rootCfg.channels);
	const coclaw = toRecord(channels.coclaw);
	const accounts = toRecord(coclaw.accounts);
	const account = toRecord(accounts.default);
	return {
		serverUrl: account.serverUrl ?? coclaw.serverUrl,
		botId: account.botId ?? coclaw.botId,
		token: account.token ?? coclaw.token,
		boundAt: account.boundAt ?? coclaw.boundAt,
	};
}

async function tryMigrateFromOldLocations() {
	// 1. 尝试从 openclaw.json channels.coclaw 迁移
	const rt = getRuntime();
	let oldData;
	if (rt?.config?.loadConfig) {
		oldData = pickFromOldConfig(rt.config.loadConfig());
	} else {
		const rootCfg = await readJson(getOpenclawConfigPath());
		oldData = pickFromOldConfig(rootCfg);
	}
	if (oldData.token) {
		return oldData;
	}

	// 2. 尝试从 legacy 文件迁移
	const legacyPaths = [
		nodePath.resolve(process.cwd(), '.coclaw-tunnel.json'),
		nodePath.join(os.homedir(), '.coclaw-tunnel.json'),
	];
	for (const p of legacyPaths) {
		const legacy = await readJson(p);
		if (legacy?.token) {
			return legacy;
		}
	}

	return null;
}

async function cleanOldLocations() {
	// 清理 openclaw.json 中的 channels.coclaw
	const rt = getRuntime();
	if (rt?.config?.loadConfig && rt?.config?.writeConfigFile) {
		const rootCfg = structuredClone(rt.config.loadConfig());
		const channels = toRecord(rootCfg.channels);
		if (channels.coclaw) {
			delete channels.coclaw;
			rootCfg.channels = channels;
			await rt.config.writeConfigFile(rootCfg);
		}
	} else {
		const filePath = getOpenclawConfigPath();
		const rootCfg = toRecord(await readJson(filePath));
		const channels = toRecord(rootCfg.channels);
		if (channels.coclaw) {
			delete channels.coclaw;
			rootCfg.channels = channels;
			await writeJson(filePath, rootCfg);
		}
	}

	// 清理 legacy 文件
	const legacyPaths = [
		nodePath.resolve(process.cwd(), '.coclaw-tunnel.json'),
		nodePath.join(os.homedir(), '.coclaw-tunnel.json'),
	];
	for (const p of legacyPaths) {
		const legacy = await readJson(p);
		if (legacy?.token) {
			await writeJson(p, {});
		}
	}
}

// --- 公共 API ---

export async function readConfig(accountId = DEFAULT_ACCOUNT_ID) {
	const bindingsPath = getBindingsPath();
	const bindings = await readJson(bindingsPath);
	const entry = toRecord(bindings[accountId]);

	if (entry.token) {
		return entry;
	}

	// 首次运行：尝试从旧位置迁移
	const migrated = await tryMigrateFromOldLocations();
	if (migrated?.token) {
		const newBindings = { ...bindings, [accountId]: migrated };
		await writeJson(bindingsPath, newBindings);
		await cleanOldLocations();
		return migrated;
	}

	return entry;
}

export async function writeConfig(nextConfig, accountId = DEFAULT_ACCOUNT_ID) {
	const bindingsPath = getBindingsPath();
	const bindings = toRecord(await readJson(bindingsPath));
	const current = toRecord(bindings[accountId]);

	const next = { ...current };
	if (nextConfig.serverUrl !== undefined) next.serverUrl = nextConfig.serverUrl;
	if (nextConfig.botId !== undefined) next.botId = nextConfig.botId;
	if (nextConfig.token !== undefined) next.token = nextConfig.token;
	if (nextConfig.boundAt !== undefined) next.boundAt = nextConfig.boundAt;

	bindings[accountId] = next;
	await writeJson(bindingsPath, bindings);
}

export async function clearConfig(accountId = DEFAULT_ACCOUNT_ID) {
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
		await writeJson(bindingsPath, bindings);
	}

	// 确保清理旧位置残留
	await cleanOldLocations();
}
