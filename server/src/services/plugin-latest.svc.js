import axios from 'axios';

// 监测的插件包（固定名；server 部署环境中没有插件源码，无法从本地读取）
const PKG_NAME = '@coclaw/openclaw-coclaw';

const SOURCES = [
	{ name: 'npmjs', baseUrl: 'https://registry.npmjs.org/' },
	{ name: 'npmmirror', baseUrl: 'https://registry.npmmirror.com/' },
];

const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

let cachedVersion = null;
let lastFetchedAt = null;
let timer = null;
// 防重入：上一轮 refresh 仍在飞时跳过本轮（DNS/代理异常导致 axios 超时漂移时避免并发堆积）
let refreshInFlight = false;

async function defaultFetchFromSource(baseUrl, timeoutMs) {
	const url = `${baseUrl}${PKG_NAME}/latest`;
	const res = await axios.get(url, { timeout: timeoutMs });
	const ver = res?.data?.version;
	if (typeof ver !== 'string' || ver.length === 0) {
		throw new Error(`invalid response from ${baseUrl}: missing version field`);
	}
	return ver;
}

function describeFetchError(err) {
	const status = err?.response?.status;
	return status ? `HTTP ${status} ${err.message}` : err?.message ?? String(err);
}

/**
 * 并行查询 npm 官方与阿里镜像；两者都成功且不同时镜像优先。
 * 全部失败时返回 null（调用方应保留缓存不变）。
 * @param {object} [deps]
 * @param {Function} [deps.fetchFromSource] - (baseUrl, timeoutMs) => Promise<string>
 * @param {{name:string, baseUrl:string}[]} [deps.sources]
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<string|null>}
 */
export async function fetchLatestVersion(deps = {}) {
	const fetchImpl = deps.fetchFromSource ?? defaultFetchFromSource;
	const sources = deps.sources ?? SOURCES;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

	const results = await Promise.allSettled(
		sources.map((s) => fetchImpl(s.baseUrl, timeoutMs))
	);

	const ok = [];
	const failed = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status === 'fulfilled') {
			ok.push({ name: sources[i].name, version: r.value });
		}
		else {
			failed.push(sources[i].name);
			console.warn(
				'[coclaw/plugin-latest] fetch failed from %s: %s',
				sources[i].name,
				describeFetchError(r.reason)
			);
		}
	}

	if (ok.length === 0) {
		console.warn(
			'[coclaw/plugin-latest] all sources failed (%s); keeping previous cache',
			failed.join(', ')
		);
		return null;
	}

	const mirror = ok.find((o) => o.name === 'npmmirror');
	const official = ok.find((o) => o.name === 'npmjs');

	// 两源都成功但版本不同：镜像优先（用户约定）
	if (mirror && official && mirror.version !== official.version) {
		console.info(
			'[coclaw/plugin-latest] version mismatch npmjs=%s npmmirror=%s, prefer mirror',
			official.version,
			mirror.version
		);
		return mirror.version;
	}

	return mirror?.version ?? official?.version ?? ok[0].version;
}

/**
 * 拉取一次并刷新缓存。成功则更新缓存，失败则保留原缓存。
 * 防重入：上一轮仍在飞时直接跳过，返回当前缓存值。
 * 版本变更时输出 info 日志；首次拉取成功也会输出；版本未变则静默，避免长期稳定时的日志噪音。
 * @param {object} [deps] - 透传给 fetchLatestVersion
 * @returns {Promise<string|null>}
 */
export async function refreshLatestVersion(deps = {}) {
	if (refreshInFlight) {
		return cachedVersion;
	}
	refreshInFlight = true;
	try {
		const ver = await fetchLatestVersion(deps);
		if (ver) {
			const prev = cachedVersion;
			cachedVersion = ver;
			lastFetchedAt = new Date();
			if (prev === null) {
				console.info('[coclaw/plugin-latest] initial cache: %s', ver);
			}
			else if (prev !== ver) {
				console.info('[coclaw/plugin-latest] version changed: %s -> %s', prev, ver);
			}
		}
		return ver;
	}
	finally {
		refreshInFlight = false;
	}
}

/** @returns {string|null} */
export function getLatestPluginVersion() {
	return cachedVersion;
}

/**
 * 启动周期轮询：立即异步发起一次，之后按间隔重复。重复调用会先停掉旧定时器。
 * @param {object} [deps]
 * @param {number} [deps.intervalMs]
 * @param {Function} [deps.fetchFromSource]
 * @param {{name:string, baseUrl:string}[]} [deps.sources]
 * @param {number} [deps.timeoutMs]
 */
export function startPolling(deps = {}) {
	stopPolling();
	const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	refreshLatestVersion(deps).catch((err) => {
		console.warn('[coclaw/plugin-latest] initial refresh failed: %s', err?.message);
	});

	timer = setInterval(() => {
		refreshLatestVersion(deps).catch((err) => {
			console.warn('[coclaw/plugin-latest] refresh failed: %s', err?.message);
		});
	}, intervalMs);
	if (typeof timer.unref === 'function') timer.unref();
	return timer;
}

export function stopPolling() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

// 测试辅助
export const __test = {
	getState: () => ({
		cachedVersion,
		lastFetchedAt,
		hasTimer: timer !== null,
		refreshInFlight,
	}),
	reset: () => {
		cachedVersion = null;
		lastFetchedAt = null;
		refreshInFlight = false;
		stopPolling();
	},
	defaultFetchFromSource,
	describeFetchError,
	PKG_NAME,
	SOURCES,
	DEFAULT_POLL_INTERVAL_MS,
};
