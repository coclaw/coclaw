import assert from 'node:assert/strict';
import test from 'node:test';

import {
	NPMJS_REGISTRY,
	NPMMIRROR_REGISTRY,
	getCurrentNpmRegistry,
	pickFallbackRegistry,
} from './registry-fallback.js';

// --- getCurrentNpmRegistry ---

test('getCurrentNpmRegistry — 正常返回 stdout 的 trim 结果', async () => {
	const execFileFn = (_cmd, _args, _opts, cb) => cb(null, 'https://registry.npmjs.org/\n', '');
	const url = await getCurrentNpmRegistry({ execFileFn });
	assert.equal(url, 'https://registry.npmjs.org/');
});

test('getCurrentNpmRegistry — 接收用户私有源', async () => {
	const execFileFn = (_cmd, _args, _opts, cb) => cb(null, 'https://my.private.npm/\n', '');
	const url = await getCurrentNpmRegistry({ execFileFn });
	assert.equal(url, 'https://my.private.npm/');
});

test('getCurrentNpmRegistry — stdout 为空时回退 npmjs', async () => {
	const execFileFn = (_cmd, _args, _opts, cb) => cb(null, '   \n', '');
	const url = await getCurrentNpmRegistry({ execFileFn });
	assert.equal(url, NPMJS_REGISTRY);
});

test('getCurrentNpmRegistry — execFile 出错时回退 npmjs', async () => {
	const execFileFn = (_cmd, _args, _opts, cb) => cb(new Error('npm not found'));
	const url = await getCurrentNpmRegistry({ execFileFn });
	assert.equal(url, NPMJS_REGISTRY);
});

test('getCurrentNpmRegistry — 透传超时参数到 execFile options', async () => {
	let captured;
	const execFileFn = (_cmd, _args, opts, cb) => {
		captured = opts;
		cb(null, 'x\n', '');
	};
	await getCurrentNpmRegistry({ execFileFn, timeoutMs: 5000 });
	assert.equal(captured.timeout, 5000);
});

// --- pickFallbackRegistry ---

test('pickFallbackRegistry — npmmirror 系 → 切回 npmjs', () => {
	assert.equal(pickFallbackRegistry('https://registry.npmmirror.com/'), NPMJS_REGISTRY);
	assert.equal(pickFallbackRegistry('https://r.cnpmjs.org/'), NPMMIRROR_REGISTRY); // 非 npmmirror.com 不算
	assert.equal(pickFallbackRegistry('https://REGISTRY.NPMMIRROR.COM/'), NPMJS_REGISTRY); // 大小写不敏感
});

test('pickFallbackRegistry — npmjs / 私有源 → 切到 npmmirror', () => {
	assert.equal(pickFallbackRegistry(NPMJS_REGISTRY), NPMMIRROR_REGISTRY);
	assert.equal(pickFallbackRegistry('https://my.private.npm/'), NPMMIRROR_REGISTRY);
});

test('pickFallbackRegistry — 非字符串输入兜底到 npmmirror', () => {
	assert.equal(pickFallbackRegistry(undefined), NPMMIRROR_REGISTRY);
	assert.equal(pickFallbackRegistry(null), NPMMIRROR_REGISTRY);
	assert.equal(pickFallbackRegistry(123), NPMMIRROR_REGISTRY);
});
