import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { resolveStateDir, CHANNEL_ID } from './config.js';
import { atomicWriteJsonFile } from './utils/atomic-write.js';
import { createMutex } from './utils/mutex.js';

const SETTINGS_FILENAME = 'settings.json';
export const MAX_NAME_LENGTH = 63;

const settingsMutex = createMutex();

function getSettingsPath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, SETTINGS_FILENAME);
}

async function readJsonSafe(filePath) {
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
	catch {
		// 文件损坏，删除后当空对象处理
		/* c8 ignore next 2 -- ?./?? fallback */
		console.warn?.(`[coclaw] corrupt settings file deleted: ${filePath}`);
		await fs.unlink(filePath).catch(() => {});
		return {};
	}
}

/**
 * 读取插件设置
 * @returns {Promise<{ name?: string }>}
 */
export async function readSettings() {
	const data = await readJsonSafe(getSettingsPath());
	return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * 写入 claw name
 * @param {string|null} name - 名称；null/空字符串/纯空白 → 清除
 */
export async function writeName(name) {
	const trimmed = typeof name === 'string' ? name.trim() : '';
	if (trimmed && trimmed.length > MAX_NAME_LENGTH) {
		throw new Error(`Name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
	}
	return settingsMutex.withLock(async () => {
		const settingsPath = getSettingsPath();
		const data = await readJsonSafe(settingsPath);
		const settings = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
		if (trimmed) {
			settings.name = trimmed;
		} else {
			delete settings.name;
		}
		await atomicWriteJsonFile(settingsPath, settings);
	});
}

/**
 * 获取 OS 主机名（去 .local 后缀）
 * @returns {string}
 */
export function getHostName() {
	const raw = os.hostname().trim();
	return raw.replace(/\.local$/i, '') || 'openclaw';
}
